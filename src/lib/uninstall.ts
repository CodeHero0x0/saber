import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readlink, readdir, unlink, writeFile, mkdir, rename, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { SaberError } from "./errors.js";
import { withRepositoryLifecycleLock } from "./lifecycle-lock.js";
import { parseRuntimeManifest, type RuntimeManifest } from "./materialize-manifest.js";
import type { ToolName } from "./models.js";
import { toolConfigAdapters } from "./tool-configs/index.js";

export type UninstallSelection = { all?: boolean; tool?: ToolName; project?: string };
export type UninstallRequest = UninstallSelection & { apply?: boolean; confirm?: string };
export type UninstallTargetPlan = {
  tool: ToolName;
  target: string;
  project: string | null;
  manifestPath: string;
  projections: string[];
  mcpEntries: Array<{ id: string; digest: string }>;
  toolConfig: { path: string; action: "remove" | "update" | "preserve" };
  currentFingerprints: Array<{ path: string; digest: string }>;
  sourceFingerprints: RuntimeManifest["sourceFingerprints"];
};
export type UninstallPlan = {
  schemaVersion: 1;
  operation: "uninstall";
  selection: { all: boolean; tool: ToolName | null; project: string | null };
  targets: UninstallTargetPlan[];
  preserved: string[];
  confirmationToken: string;
};
export type UninstallResult = { applied: boolean; plan: UninstallPlan };
export type UninstallDependencies = { beforeMutation?: (kind: string, path: string) => Promise<void> };

const tools: readonly ToolName[] = ["codex", "claude", "opencode"];
const discoveryDirectories: Record<ToolName, string> = {
  codex: ".agents/skills", claude: ".claude/skills", opencode: ".opencode/skills",
};
const safeTarget = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const tokenPattern = /^sha256:[a-f0-9]{64}$/u;
const previewDirectory = ".saber/runtime/uninstall-previews";

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function fingerprint(value: unknown): string { return `sha256:${digest(typeof value === "string" ? value : JSON.stringify(value))}`; }
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (["ENOENT", "ENOTDIR"].includes((error as { code?: string }).code ?? ""));
}
function safeRelativePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.startsWith("\\")
    && !value.split(/[\\/]+/u).includes("..");
}
function pathOf(root: string, path: string): string {
  if (!safeRelativePath(path)) throw new SaberError(`uninstall path escapes repository root: ${path}`, 2);
  const resolved = resolve(root, path);
  const fromRoot = relative(resolve(root), resolved);
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new SaberError(`uninstall path escapes repository root: ${path}`, 2);
  }
  return resolved;
}
async function assertSafeParents(root: string, path: string): Promise<void> {
  let current = resolve(root);
  const parts = path.split(/[\\/]+/u);
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new SaberError(`uninstall path contains an unsafe parent: ${path}`, 2);
    } catch (error: unknown) { if (!isMissing(error)) throw error; return; }
  }
}
async function readOwned(root: string, path: string, label: string): Promise<string> {
  await assertSafeParents(root, path);
  const absolute = pathOf(root, path);
  let status;
  try { status = await lstat(absolute); } catch (error: unknown) { if (isMissing(error)) throw new SaberError(`${label} is missing`, 2); throw error; }
  if (!status.isFile() || status.isSymbolicLink()) throw new SaberError(`${label} is not a regular Saber-owned file`, 2);
  return readFile(absolute, "utf8");
}
async function readOptional(root: string, path: string): Promise<string | undefined> {
  try { return await readOwned(root, path, "managed tool configuration"); } catch (error: unknown) {
    if (error instanceof SaberError && error.message === "managed tool configuration is missing") return undefined;
    throw error;
  }
}
function selectionOf(selection: UninstallSelection): UninstallPlan["selection"] {
  const all = selection.all === true;
  if (all && (selection.tool !== undefined || selection.project !== undefined)) throw new SaberError("--all cannot be combined with --tool or --project", 2);
  if (!all && selection.tool === undefined) throw new SaberError("--tool is required unless --all is used", 2);
  if (selection.project !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(selection.project)) throw new SaberError("--project contains an invalid project name", 2);
  return { all, tool: selection.tool ?? null, project: selection.project ?? null };
}
async function manifestPaths(root: string, selection: UninstallPlan["selection"]): Promise<string[]> {
  if (!selection.all) return [`.saber/runtime/materialize/${selection.tool}/${selection.project ?? "root"}.json`];
  const result: string[] = [];
  for (const tool of tools) {
    const directory = `.saber/runtime/materialize/${tool}`;
    try {
      const entries = await readdir(pathOf(root, directory));
      for (const entry of entries) if (entry.endsWith(".json")) result.push(`${directory}/${entry}`);
    } catch (error: unknown) { if (!isMissing(error)) throw error; }
  }
  return result.sort();
}
function targetPrefix(manifest: RuntimeManifest): string {
  const adapterPath = toolConfigAdapters[manifest.tool].relativePath.replaceAll("\\", "/");
  const configPath = manifest.toolConfig.path.replaceAll("\\", "/");
  if (manifest.project === null) {
    if (manifest.target !== "root" || configPath !== adapterPath) throw new SaberError("uninstall manifest does not match its root target", 2);
    return "";
  }
  if (manifest.target !== manifest.project || !safeTarget.test(manifest.project) || !configPath.endsWith(`/${adapterPath}`)) throw new SaberError("uninstall manifest does not match its project target", 2);
  const prefix = configPath.slice(0, -(adapterPath.length + 1));
  if (!safeRelativePath(prefix)) throw new SaberError("uninstall manifest contains an unsafe project path", 2);
  return prefix;
}
function prefixed(prefix: string, path: string): string { return prefix.length === 0 ? path : `${prefix}/${path}`; }
function emptyConfig(tool: ToolName): string { return tool === "codex" ? "" : "{}\n"; }

type Prepared = { plan: UninstallTargetPlan; manifestText: string; configText?: string; nextConfig?: string; links: string[] };
async function prepareTarget(root: string, manifestPath: string, selection: UninstallPlan["selection"]): Promise<Prepared | undefined> {
  let manifestText: string;
  try { manifestText = await readOwned(root, manifestPath, "materialize runtime manifest"); }
  catch (error: unknown) { if (!selection.all && error instanceof SaberError && error.message === "materialize runtime manifest is missing") return undefined; throw error; }
  const manifest = parseRuntimeManifest(manifestText);
  const expected = `.saber/runtime/materialize/${manifest.tool}/${manifest.project ?? "root"}.json`;
  if (manifestPath !== expected) throw new SaberError("materialize runtime manifest does not match its managed path", 2);
  if (!selection.all && (manifest.tool !== selection.tool || manifest.project !== selection.project)) throw new SaberError("materialize runtime manifest does not match the selected target", 2);
  const prefix = targetPrefix(manifest);
  const links: string[] = [];
  const currentFingerprints = [{ path: manifestPath, digest: digest(manifestText) }];
  for (const projection of manifest.projections) {
    const expectedLink = `${discoveryDirectories[manifest.tool]}/${projection.name}`;
    if (projection.linkPath !== expectedLink) throw new SaberError("materialize manifest contains an unsafe projection path", 2);
    const path = prefixed(prefix, projection.linkPath);
    await assertSafeParents(root, path);
    let status; try { status = await lstat(pathOf(root, path)); } catch (error: unknown) { if (isMissing(error)) throw new SaberError(`managed projection ${path} is missing`, 2); throw error; }
    if (!status.isSymbolicLink() || await readlink(pathOf(root, path)) !== projection.linkTarget) throw new SaberError(`managed projection ${path} was changed`, 2);
    links.push(path); currentFingerprints.push({ path, digest: fingerprint({ target: projection.linkTarget, source: projection.sourcePath }) });
  }
  const configText = await readOptional(root, manifest.toolConfig.path);
  const adapter = toolConfigAdapters[manifest.tool];
  const snapshot = adapter.inspect(configText);
  adapter.verify(snapshot, manifest.mcpEntries);
  const removed = adapter.remove(snapshot, manifest.mcpEntries);
  const nextConfig = removed === null ? (manifest.toolConfig.createdBySaber ? undefined : emptyConfig(manifest.tool)) : removed;
  const action = nextConfig === configText ? "preserve" : nextConfig === undefined ? "remove" : "update";
  currentFingerprints.push({ path: manifest.toolConfig.path, digest: configText === undefined ? "missing" : digest(configText) });
  return {
    plan: {
      tool: manifest.tool, target: manifest.target, project: manifest.project, manifestPath,
      projections: links.sort(), mcpEntries: manifest.mcpEntries.map(({ id, digest: entryDigest }) => ({ id, digest: entryDigest })).sort((a, b) => a.id.localeCompare(b.id)),
      toolConfig: { path: manifest.toolConfig.path, action }, currentFingerprints: currentFingerprints.sort((a, b) => a.path.localeCompare(b.path)), sourceFingerprints: manifest.sourceFingerprints,
    }, manifestText, configText, nextConfig, links,
  };
}
function planContent(selection: UninstallPlan["selection"], targets: Prepared[]): Omit<UninstallPlan, "confirmationToken"> {
  return { schemaVersion: 1, operation: "uninstall", selection, targets: targets.map(({ plan }) => plan), preserved: ["user configuration outside Saber-owned MCP entries", "business repositories" ] };
}
type PreviewRecord = { schemaVersion: 1; nonce: string; token: string; planDigest: string };

async function ensurePreviewDirectory(root: string): Promise<void> {
  let current = resolve(root);
  for (const segment of previewDirectory.split("/")) {
    current = resolve(current, segment);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SaberError("uninstall preview storage is unsafe", 3);
      }
    } catch (error: unknown) {
      if (error instanceof SaberError) throw error;
      if (!isMissing(error)) throw new SaberError("uninstall preview storage is unavailable", 3);
      try { await mkdir(current); } catch (mkdirError: unknown) {
        if (!(typeof mkdirError === "object" && mkdirError !== null && "code" in mkdirError && mkdirError.code === "EEXIST")) {
          throw new SaberError("uninstall preview storage is unavailable", 3);
        }
      }
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SaberError("uninstall preview storage is unsafe", 3);
      }
    }
  }
}

function parsePreviewRecord(value: unknown): PreviewRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<PreviewRecord>;
  if (
    Object.keys(value).sort().join(",") !== "nonce,planDigest,schemaVersion,token"
    || record.schemaVersion !== 1
    || typeof record.nonce !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.nonce)
    || typeof record.planDigest !== "string"
    || !tokenPattern.test(record.planDigest)
    || typeof record.token !== "string"
    || !tokenPattern.test(record.token)
    || record.token !== fingerprint({ nonce: record.nonce, planDigest: record.planDigest })
  ) return undefined;
  return record as PreviewRecord;
}

async function issuePreview(root: string, content: Omit<UninstallPlan, "confirmationToken">): Promise<UninstallPlan> {
  await ensurePreviewDirectory(root);
  const nonce = randomBytes(32).toString("hex");
  const planDigest = fingerprint(content);
  const token = fingerprint({ nonce, planDigest });
  const record: PreviewRecord = { schemaVersion: 1, nonce, token, planDigest };
  await writeFile(pathOf(root, `${previewDirectory}/${nonce}.json`), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { ...content, confirmationToken: token };
}
async function consumePreview(root: string, token: string): Promise<PreviewRecord> {
  if (!tokenPattern.test(token)) throw new SaberError("uninstall confirmation token is stale or invalid", 3);
  let entries: string[]; try { entries = await readdir(pathOf(root, previewDirectory)); } catch { throw new SaberError("uninstall confirmation token is stale or invalid", 3); }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = `${previewDirectory}/${entry}`;
    let record: PreviewRecord | undefined;
    try { record = parsePreviewRecord(JSON.parse(await readOwned(root, path, "uninstall preview record")) as unknown); } catch { continue; }
    if (record === undefined || entry !== `${record.nonce}.json`) continue;
    if (record.token !== token) continue;
    await unlink(pathOf(root, path));
    return record;
  }
  throw new SaberError("uninstall confirmation token is stale or invalid", 3);
}
async function writeAtomic(root: string, path: string, content: string | undefined): Promise<void> {
  const absolute = pathOf(root, path);
  if (content === undefined) { try { await unlink(absolute); } catch (error: unknown) { if (!isMissing(error)) throw error; } return; }
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${randomBytes(8).toString("hex")}`;
  try { await writeFile(temporary, content, { encoding: "utf8", flag: "wx" }); await rename(temporary, absolute); }
  finally { try { await unlink(temporary); } catch (error: unknown) { if (!isMissing(error)) throw error; } }
}
async function apply(root: string, targets: Prepared[], dependencies: UninstallDependencies): Promise<void> {
  const backups = new Map<string, string | undefined>();
  const linkBackups = new Map<string, string>();
  const remember = async (path: string) => { if (!backups.has(path)) { try { backups.set(path, await readFile(pathOf(root, path), "utf8")); } catch (error: unknown) { if (isMissing(error)) backups.set(path, undefined); else throw error; } } };
  try {
    for (const target of targets) {
      await remember(target.plan.toolConfig.path); await remember(target.plan.manifestPath);
      await dependencies.beforeMutation?.("tool-config", target.plan.toolConfig.path); await writeAtomic(root, target.plan.toolConfig.path, target.nextConfig);
      for (const link of target.links) {
        await dependencies.beforeMutation?.("projection", link);
        linkBackups.set(link, await readlink(pathOf(root, link)));
        await unlink(pathOf(root, link));
      }
      await dependencies.beforeMutation?.("manifest", target.plan.manifestPath); await unlink(pathOf(root, target.plan.manifestPath));
    }
  } catch (error: unknown) {
    for (const [path, content] of backups) await writeAtomic(root, path, content);
    for (const [path, target] of linkBackups) {
      await mkdir(dirname(pathOf(root, path)), { recursive: true });
      await symlink(target, pathOf(root, path), "dir").catch(() => undefined);
    }
    throw error;
  }
}
export async function previewUninstall(root: string, selection: UninstallSelection): Promise<UninstallPlan> {
  return withRepositoryLifecycleLock(root, async () => {
    const normalized = selectionOf(selection);
    const prepared = (await Promise.all((await manifestPaths(root, normalized)).map((path) => prepareTarget(root, path, normalized)))).filter((item): item is Prepared => item !== undefined);
    return issuePreview(root, planContent(normalized, prepared));
  });
}
export async function uninstall(root: string, request: UninstallRequest, dependencies: UninstallDependencies = {}): Promise<UninstallResult> {
  if (request.confirm !== undefined && request.apply !== true) throw new SaberError("--confirm requires --apply", 2);
  if (request.apply === true && request.confirm === undefined) throw new SaberError("--apply requires --confirm <preview-token>", 2);
  return withRepositoryLifecycleLock(root, async () => {
    const normalized = selectionOf(request);
    if (request.apply !== true) {
      const prepared = (await Promise.all((await manifestPaths(root, normalized)).map((path) => prepareTarget(root, path, normalized)))).filter((item): item is Prepared => item !== undefined);
      return { applied: false, plan: await issuePreview(root, planContent(normalized, prepared)) };
    }
    const pending = await consumePreview(root, request.confirm!);
    const prepared = (await Promise.all((await manifestPaths(root, normalized)).map((path) => prepareTarget(root, path, normalized)))).filter((item): item is Prepared => item !== undefined);
    const content = planContent(normalized, prepared);
    if (fingerprint(content) !== pending.planDigest) throw new SaberError("uninstall confirmation token is stale or invalid", 3);
    await apply(root, prepared, dependencies);
    return { applied: true, plan: { ...content, confirmationToken: request.confirm! } };
  });
}
