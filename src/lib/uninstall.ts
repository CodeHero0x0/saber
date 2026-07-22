import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { SaberError } from "./errors.js";
import { withRepositoryLifecycleLock } from "./lifecycle-lock.js";
import { parseRuntimeManifest, type RuntimeManifest } from "./materialize-manifest.js";
import { loadMcpActiveIndex } from "./mcp/runtime.js";
import type { ToolName } from "./models.js";
import { toolConfigAdapters } from "./tool-configs/index.js";

export type UninstallSelection = {
  all?: boolean;
  tool?: ToolName;
  project?: string;
};

export type UninstallRequest = UninstallSelection & {
  apply?: boolean;
  confirm?: string;
};

export type UninstallTargetPlan = {
  tool: ToolName;
  target: string;
  project: string | null;
  manifestPath: string;
  projections: string[];
  mcpEntries: Array<{ id: string; digest: string }>;
  descriptors: string[];
  activeIndex: string;
  contextPath: string;
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

export type UninstallResult = {
  applied: boolean;
  plan: UninstallPlan;
};

export type UninstallDependencies = {
  /** Test-only failure boundary used to prove that the complete batch rolls back. */
  beforeMutation?: (kind: string, path: string) => Promise<void>;
};

type PreparedTarget = {
  plan: UninstallTargetPlan;
  manifestText: string;
  toolConfigText: string | undefined;
  nextToolConfigText: string | undefined;
  contextFilePath: string;
  projectionLinks: Array<{ path: string; target: string }>;
};

type UninstallPlanContent = Omit<UninstallPlan, "confirmationToken">;
type PreparedPlan = { content: UninstallPlanContent; targets: PreparedTarget[] };
type PreviewRecord = {
  schemaVersion: 1;
  managedBy: "saber";
  operation: "uninstall-preview";
  nonce: string;
  token: string;
  planDigest: string;
  createdAt: string;
};
type TransactionFile = { path: string; content: string | null };
type TransactionLink = { path: string; target: string | null };
type TransactionScope = {
  tool: ToolName;
  target: string;
  projectPath: string | null;
  descriptors: string[];
  projections: string[];
};
type TransactionSnapshot = {
  schemaVersion: 3;
  managedBy: "saber";
  operation: "materialize" | "uninstall";
  tool: ToolName | null;
  target: string | null;
  scopes: TransactionScope[];
  files: TransactionFile[];
  links: TransactionLink[];
  directories: string[];
};

const tools: readonly ToolName[] = ["codex", "claude", "opencode"];
const discoveryDirectories: Record<ToolName, string> = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  opencode: ".opencode/skills",
};
const safeTarget = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const safeMcpId = /^[a-z][a-z0-9-]{0,63}$/u;
const safeProjectionName = /^saber--[a-z0-9][a-z0-9._-]*(?:--[a-z0-9][a-z0-9._-]*)*$/u;
const materializeTransactionName = /^materialize--(codex|claude|opencode)--([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/u;
const transactionRelativePath = ".saber/runtime/transactions/uninstall.json";
const previewDirectoryRelativePath = ".saber/runtime/uninstall-previews";
const consumedPreviewDirectoryRelativePath = `${previewDirectoryRelativePath}/consumed`;
const previewFilename = /^([a-f0-9]{64})\.json$/u;
const confirmationToken = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT"
      || (error as { code?: unknown }).code === "ENOTDIR");
}

function isNotEmpty(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOTEMPTY";
}

function safeRelativePath(value: string): boolean {
  return value.length > 0
    && !isAbsolute(value)
    && !value.startsWith("\\")
    && !value.split(/[\\/]+/u).includes("..");
}

function repositoryPath(repositoryRoot: string, relativePath: string): string {
  if (!safeRelativePath(relativePath)) {
    throw new SaberError(`uninstall path escapes repository root: ${relativePath}`, 2);
  }
  const root = resolve(repositoryRoot);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new SaberError(`uninstall path escapes repository root: ${relativePath}`, 2);
  }
  return path;
}

async function assertNoSymlinkParents(repositoryRoot: string, relativePath: string): Promise<void> {
  const parts = relativePath.split(/[\\/]+/u);
  let current = resolve(repositoryRoot);
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    let status;
    try {
      status = await lstat(current);
    } catch (error: unknown) {
      if (isMissing(error)) return;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new SaberError(`uninstall path contains an unsafe parent: ${relativePath}`, 2);
    }
  }
}

async function readOwnedFile(
  repositoryRoot: string,
  relativePath: string,
  label: string,
): Promise<string> {
  const path = repositoryPath(repositoryRoot, relativePath);
  await assertNoSymlinkParents(repositoryRoot, relativePath);
  let status;
  try {
    status = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) throw new SaberError(`${label} is missing`, 2);
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new SaberError(`${label} is not a regular Saber-owned file`, 2);
  }
  const [root, canonical] = await Promise.all([realpath(repositoryRoot), realpath(path)]);
  const fromRoot = relative(root, canonical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new SaberError(`${label} escapes repository root`, 2);
  }
  return readFile(path, "utf8");
}

async function readOptionalOwnedFile(
  repositoryRoot: string,
  relativePath: string,
  label: string,
): Promise<string | undefined> {
  try {
    return await readOwnedFile(repositoryRoot, relativePath, label);
  } catch (error: unknown) {
    if (error instanceof SaberError && error.message === `${label} is missing`) return undefined;
    throw error;
  }
}

function rawDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function normalizedSelection(selection: UninstallSelection): UninstallPlan["selection"] {
  const all = selection.all === true;
  const tool = selection.tool ?? null;
  const project = selection.project ?? null;
  if (all && (tool !== null || project !== null)) {
    throw new SaberError("--all cannot be combined with --tool or --project", 2);
  }
  if (!all && tool === null) {
    throw new SaberError("--tool is required unless --all is used", 2);
  }
  if (project !== null && tool === null) {
    throw new SaberError("--project requires --tool", 2);
  }
  if (project !== null && !safeTarget.test(project)) {
    throw new SaberError("--project contains an invalid project name", 2);
  }
  return { all, tool, project };
}

async function selectedManifestPaths(
  repositoryRoot: string,
  selection: UninstallPlan["selection"],
): Promise<string[]> {
  if (!selection.all) {
    return [`.saber/runtime/materialize/${selection.tool}/${selection.project ?? "root"}.json`];
  }
  const paths: string[] = [];
  for (const tool of tools) {
    const directoryRelative = `.saber/runtime/materialize/${tool}`;
    const directory = repositoryPath(repositoryRoot, directoryRelative);
    await assertNoSymlinkParents(repositoryRoot, `${directoryRelative}/placeholder`);
    let status;
    try {
      status = await lstat(directory);
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new SaberError("materialize manifest directory is unsafe", 2);
    }
    for (const entry of await readdir(directory)) {
      if (entry.endsWith(".json")) paths.push(`${directoryRelative}/${entry}`);
    }
  }
  return paths.sort();
}

function targetPrefix(manifest: RuntimeManifest): string {
  const adapterPath = toolConfigAdapters[manifest.tool].relativePath.replaceAll("\\", "/");
  const configPath = manifest.toolConfig.path.replaceAll("\\", "/");
  if (manifest.project === null) {
    if (manifest.target !== "root" || configPath !== adapterPath) {
      throw new SaberError("uninstall manifest does not match its root target", 2);
    }
    return "";
  }
  if (manifest.target !== manifest.project || !safeTarget.test(manifest.project)) {
    throw new SaberError("uninstall manifest does not match its project target", 2);
  }
  const suffix = `/${adapterPath}`;
  if (!configPath.endsWith(suffix)) {
    throw new SaberError("uninstall manifest contains an unsafe tool configuration path", 2);
  }
  const prefix = configPath.slice(0, -suffix.length);
  if (!safeRelativePath(prefix)) {
    throw new SaberError("uninstall manifest contains an unsafe project path", 2);
  }
  return prefix;
}

function withPrefix(prefix: string, relativePath: string): string {
  return prefix.length === 0 ? relativePath : `${prefix}/${relativePath}`;
}

function emptyUserToolConfig(tool: ToolName): string {
  return tool === "codex" ? "" : "{}\n";
}

async function prepareTarget(
  repositoryRoot: string,
  manifestPath: string,
  selection: UninstallPlan["selection"],
): Promise<PreparedTarget | undefined> {
  let manifestText: string;
  try {
    manifestText = await readOwnedFile(repositoryRoot, manifestPath, "materialize runtime manifest");
  } catch (error: unknown) {
    if (
      !selection.all
      && error instanceof SaberError
      && error.message === "materialize runtime manifest is missing"
    ) return undefined;
    throw error;
  }
  const manifest = parseRuntimeManifest(manifestText);
  const filename = manifest.project ?? "root";
  const expectedManifestPath = `.saber/runtime/materialize/${manifest.tool}/${filename}.json`;
  if (manifestPath !== expectedManifestPath) {
    throw new SaberError("materialize runtime manifest does not match its managed path", 2);
  }
  if (!selection.all && (manifest.tool !== selection.tool || manifest.project !== selection.project)) {
    throw new SaberError("materialize runtime manifest does not match the selected target", 2);
  }
  const prefix = targetPrefix(manifest);
  const discovery = discoveryDirectories[manifest.tool];
  const projectionLinks: Array<{ path: string; target: string }> = [];
  const projectionPaths: string[] = [];
  let contextPath: string | undefined;
  let contextFilePath: string | undefined;
  const currentFingerprints: Array<{ path: string; digest: string }> = [
    { path: manifestPath, digest: rawDigest(manifestText) },
  ];

  for (const projection of manifest.projections) {
    if (projection.linkPath !== `${discovery}/${projection.name}`) {
      throw new SaberError("materialize runtime manifest contains an unsafe projection path", 2);
    }
    const repositoryLinkPath = withPrefix(prefix, projection.linkPath);
    const linkPath = repositoryPath(repositoryRoot, repositoryLinkPath);
    await assertNoSymlinkParents(repositoryRoot, repositoryLinkPath);
    let status;
    try { status = await lstat(linkPath); } catch (error: unknown) {
      if (isMissing(error)) throw new SaberError(`managed projection ${repositoryLinkPath} is missing`, 2);
      throw error;
    }
    if (!status.isSymbolicLink()) {
      throw new SaberError(`managed projection ${repositoryLinkPath} was replaced`, 2);
    }
    const actualTarget = await readlink(linkPath);
    if (actualTarget !== projection.linkTarget) {
      throw new SaberError(`managed projection ${repositoryLinkPath} was changed`, 2);
    }
    const sourcePath = repositoryPath(repositoryRoot, projection.sourcePath);
    await assertNoSymlinkParents(repositoryRoot, projection.sourcePath);
    let sourceStatus;
    try { sourceStatus = await lstat(sourcePath); } catch {
      throw new SaberError(`managed projection ${repositoryLinkPath} source is missing`, 2);
    }
    if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
      throw new SaberError(`managed projection ${repositoryLinkPath} source is unsafe`, 2);
    }
    const [canonicalRoot, canonicalLink, canonicalSource] = await Promise.all([
      realpath(repositoryRoot),
      realpath(linkPath),
      realpath(sourcePath),
    ]);
    const sourceFromRoot = relative(canonicalRoot, canonicalSource);
    if (
      sourceFromRoot === ".."
      || sourceFromRoot.startsWith(`..${sep}`)
      || isAbsolute(sourceFromRoot)
      || canonicalLink !== canonicalSource
    ) {
      throw new SaberError(`managed projection ${repositoryLinkPath} was redirected`, 2);
    }
    projectionLinks.push({ path: repositoryLinkPath, target: actualTarget });
    projectionPaths.push(repositoryLinkPath);
    currentFingerprints.push({
      path: repositoryLinkPath,
      digest: fingerprint({ target: actualTarget, source: projection.sourcePath }),
    });
    if (projection.kind === "context") {
      const expectedContext = `.saber/runtime/materialize/${manifest.tool}/${manifest.target}/context`;
      if (projection.sourcePath !== expectedContext || contextPath !== undefined) {
        throw new SaberError("materialize runtime manifest contains an unsafe context runtime", 2);
      }
      contextPath = expectedContext;
      const entries = await readdir(sourcePath);
      if (entries.length !== 1 || entries[0] !== "SKILL.md") {
        throw new SaberError("managed context runtime contains unmanaged content", 2);
      }
      contextFilePath = `${expectedContext}/SKILL.md`;
      const contextText = await readOwnedFile(repositoryRoot, contextFilePath, "managed context runtime");
      if (rawDigest(contextText) !== projection.sourceDigest) {
        throw new SaberError("managed context runtime does not match its manifest", 2);
      }
      currentFingerprints.push({ path: contextFilePath, digest: rawDigest(contextText) });
    }
  }
  if (contextPath === undefined || contextFilePath === undefined) {
    throw new SaberError("materialize runtime manifest is missing its context runtime", 2);
  }

  if (!manifest.mcpServers.every((id) => safeMcpId.test(id))) {
    throw new SaberError("materialize runtime manifest contains an unsafe MCP server id", 2);
  }
  const expectedActive = `.saber/runtime/mcp/${manifest.tool}/${manifest.target}/_active.json`;
  if (manifest.activeIndex.path !== expectedActive) {
    throw new SaberError("materialize runtime manifest contains an unsafe MCP active index path", 2);
  }
  const activeText = await readOwnedFile(repositoryRoot, expectedActive, "managed MCP active index");
  if (rawDigest(activeText) !== manifest.activeIndex.digest) {
    throw new SaberError("managed MCP active index does not match its manifest", 2);
  }
  const activeIndex = await loadMcpActiveIndex(repositoryRoot, manifest.tool, manifest.target);
  if (activeIndex.descriptors.length !== manifest.descriptors.length) {
    throw new SaberError("managed MCP active index does not match its manifest", 2);
  }
  currentFingerprints.push({ path: expectedActive, digest: manifest.activeIndex.digest });

  const descriptorPaths: string[] = [];
  for (const descriptor of manifest.descriptors) {
    const expectedPath = `.saber/runtime/mcp/${manifest.tool}/${manifest.target}/${descriptor.id}.json`;
    if (descriptor.path !== expectedPath) {
      throw new SaberError("materialize runtime manifest contains an unsafe MCP descriptor path", 2);
    }
    const active = activeIndex.descriptors.find((entry) => entry.file === `${descriptor.id}.json`);
    if (
      active === undefined
      || active.descriptorFingerprint !== descriptor.descriptorFingerprint
      || active.sourceFingerprint !== descriptor.sourceFingerprint
    ) {
      throw new SaberError(`managed MCP descriptor ${descriptor.id} is not active`, 2);
    }
    const text = await readOwnedFile(repositoryRoot, expectedPath, `managed MCP descriptor ${descriptor.id}`);
    if (rawDigest(text) !== descriptor.digest) {
      throw new SaberError(`managed MCP descriptor ${descriptor.id} does not match its manifest`, 2);
    }
    descriptorPaths.push(expectedPath);
    currentFingerprints.push({ path: expectedPath, digest: descriptor.digest });
  }

  const adapter = toolConfigAdapters[manifest.tool];
  const toolConfigText = await readOptionalOwnedFile(
    repositoryRoot,
    manifest.toolConfig.path,
    "managed tool configuration",
  );
  const snapshot = adapter.inspect(toolConfigText);
  adapter.verify(snapshot, manifest.mcpEntries);
  const removed = manifest.mcpEntries.length === 0
    ? toolConfigText
    : adapter.remove(snapshot, manifest.mcpEntries);
  const nextToolConfigText = removed === null
    ? (manifest.toolConfig.createdBySaber ? undefined : emptyUserToolConfig(manifest.tool))
    : removed;
  const action = nextToolConfigText === toolConfigText
    ? "preserve"
    : nextToolConfigText === undefined ? "remove" : "update";
  currentFingerprints.push({
    path: manifest.toolConfig.path,
    digest: toolConfigText === undefined ? "missing" : rawDigest(toolConfigText),
  });

  const plan: UninstallTargetPlan = {
    tool: manifest.tool,
    target: manifest.target,
    project: manifest.project,
    manifestPath,
    projections: projectionPaths.sort(),
    mcpEntries: manifest.mcpEntries
      .map(({ id, digest }) => ({ id, digest }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    descriptors: descriptorPaths.sort(),
    activeIndex: expectedActive,
    contextPath,
    toolConfig: { path: manifest.toolConfig.path, action },
    currentFingerprints: currentFingerprints.sort((left, right) => left.path.localeCompare(right.path)),
    sourceFingerprints: manifest.sourceFingerprints,
  };
  return {
    plan,
    manifestText,
    toolConfigText,
    nextToolConfigText,
    contextFilePath,
    projectionLinks,
  };
}

function assertDisjointTargets(targets: readonly PreparedTarget[]): void {
  const paths = new Set<string>();
  for (const target of targets) {
    const owned = [
      target.plan.manifestPath,
      target.plan.toolConfig.path,
      target.plan.activeIndex,
      target.contextFilePath,
      ...target.plan.projections,
      ...target.plan.descriptors,
    ];
    for (const path of owned) {
      if (paths.has(path)) throw new SaberError(`multiple uninstall targets claim ${path}`, 2);
      paths.add(path);
    }
  }
}

async function preparePlan(
  repositoryRoot: string,
  selectionInput: UninstallSelection,
): Promise<PreparedPlan> {
  const selection = normalizedSelection(selectionInput);
  await recoverLifecycleTransactions(repositoryRoot);
  const prepared = await Promise.all(
    (await selectedManifestPaths(repositoryRoot, selection))
      .map((path) => prepareTarget(repositoryRoot, path, selection)),
  );
  const targets = prepared
    .filter((target): target is PreparedTarget => target !== undefined)
    .sort((left, right) => left.plan.manifestPath.localeCompare(right.plan.manifestPath));
  assertDisjointTargets(targets);
  const content: UninstallPlanContent = {
    schemaVersion: 1,
    operation: "uninstall",
    selection,
    targets: targets.map(({ plan }) => plan),
    preserved: ["external-assets", "projects", "source-assets", "unmanaged-tool-configuration"],
  };
  return { content, targets };
}

function parsePreviewRecord(text: string): PreviewRecord {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch {
    throw new SaberError("uninstall preview record is invalid", 3);
  }
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "createdAt,managedBy,nonce,operation,planDigest,schemaVersion,token"
    || value.schemaVersion !== 1
    || value.managedBy !== "saber"
    || value.operation !== "uninstall-preview"
    || typeof value.nonce !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.nonce)
    || typeof value.token !== "string"
    || !confirmationToken.test(value.token)
    || typeof value.planDigest !== "string"
    || !confirmationToken.test(value.planDigest)
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || fingerprint({ nonce: value.nonce, planDigest: value.planDigest }) !== value.token
  ) throw new SaberError("uninstall preview record is invalid", 3);
  return value as PreviewRecord;
}

async function assertSafeDirectory(repositoryRoot: string, relativePath: string): Promise<string> {
  await assertNoSymlinkParents(repositoryRoot, `${relativePath}/record.json`);
  const path = repositoryPath(repositoryRoot, relativePath);
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new SaberError("uninstall preview storage is unsafe", 3);
    }
  } catch (error: unknown) {
    if (error instanceof SaberError) throw error;
    if (!isMissing(error)) throw error;
  }
  return path;
}

async function ensurePreviewDirectory(repositoryRoot: string, relativePath: string): Promise<string> {
  const path = await assertSafeDirectory(repositoryRoot, relativePath);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  return assertSafeDirectory(repositoryRoot, relativePath);
}

async function issuePreview(
  repositoryRoot: string,
  content: UninstallPlanContent,
): Promise<UninstallPlan> {
  const directory = await ensurePreviewDirectory(repositoryRoot, previewDirectoryRelativePath);
  for (;;) {
    const nonce = randomBytes(32).toString("hex");
    const planDigest = fingerprint(content);
    const token = fingerprint({ nonce, planDigest });
    const record: PreviewRecord = {
      schemaVersion: 1,
      managedBy: "saber",
      operation: "uninstall-preview",
      nonce,
      token,
      planDigest,
      createdAt: new Date().toISOString(),
    };
    const relativePath = `${previewDirectoryRelativePath}/${nonce}.json`;
    await assertNoSymlinkParents(repositoryRoot, relativePath);
    try {
      await writeFile(repositoryPath(repositoryRoot, relativePath), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return { ...content, confirmationToken: token };
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
}

async function previewRecords(
  repositoryRoot: string,
  relativeDirectory: string,
): Promise<Array<{ path: string; record: PreviewRecord }>> {
  const directory = await assertSafeDirectory(repositoryRoot, relativeDirectory);
  let entries: string[];
  try { entries = await readdir(directory); } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records: Array<{ path: string; record: PreviewRecord }> = [];
  for (const entry of entries.sort()) {
    if (relativeDirectory === previewDirectoryRelativePath && entry === "consumed") continue;
    const match = previewFilename.exec(entry);
    if (match === null) throw new SaberError("uninstall preview storage contains unmanaged content", 3);
    const relativePath = `${relativeDirectory}/${entry}`;
    const text = await readOwnedFile(repositoryRoot, relativePath, "uninstall preview record");
    const record = parsePreviewRecord(text);
    if (record.nonce !== match[1]) throw new SaberError("uninstall preview record is invalid", 3);
    records.push({ path: relativePath, record });
  }
  return records;
}

async function findPendingPreview(
  repositoryRoot: string,
  token: string,
): Promise<{ path: string; record: PreviewRecord }> {
  if (!confirmationToken.test(token)) {
    throw new SaberError("uninstall confirmation token is stale or invalid", 3);
  }
  const consumed = await previewRecords(repositoryRoot, consumedPreviewDirectoryRelativePath);
  if (consumed.some(({ record }) => record.token === token)) {
    throw new SaberError("uninstall confirmation token was already consumed", 3);
  }
  const found = (await previewRecords(repositoryRoot, previewDirectoryRelativePath))
    .find(({ record }) => record.token === token);
  if (found === undefined) throw new SaberError("uninstall confirmation token is stale or invalid", 3);
  return found;
}

async function consumePreview(
  repositoryRoot: string,
  pending: { path: string; record: PreviewRecord },
): Promise<void> {
  await ensurePreviewDirectory(
    repositoryRoot,
    consumedPreviewDirectoryRelativePath,
  );
  const destination = `${consumedPreviewDirectoryRelativePath}/${pending.record.nonce}.json`;
  await assertNoSymlinkParents(repositoryRoot, destination);
  try {
    await link(
      repositoryPath(repositoryRoot, pending.path),
      repositoryPath(repositoryRoot, destination),
    );
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new SaberError("uninstall confirmation token was already consumed", 3);
    }
    throw error;
  }
  await unlink(repositoryPath(repositoryRoot, pending.path));
}

export async function previewUninstall(
  repositoryRoot: string,
  selection: UninstallSelection,
): Promise<UninstallPlan> {
  return withRepositoryLifecycleLock(
    repositoryRoot,
    async () => {
      const prepared = await preparePlan(repositoryRoot, selection);
      return issuePreview(repositoryRoot, prepared.content);
    },
  );
}

function transactionScope(value: unknown): value is TransactionScope {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "descriptors,projectPath,projections,target,tool"
    || (value.tool !== "codex" && value.tool !== "claude" && value.tool !== "opencode")
    || typeof value.target !== "string"
    || !safeTarget.test(value.target)
    || (value.projectPath !== null
      && (typeof value.projectPath !== "string" || !safeRelativePath(value.projectPath)))
    || (value.target === "root") !== (value.projectPath === null)
    || !Array.isArray(value.descriptors)
    || !value.descriptors.every((entry) => typeof entry === "string" && safeMcpId.test(entry))
    || new Set(value.descriptors).size !== value.descriptors.length
    || !Array.isArray(value.projections)
    || !value.projections.every((entry) => typeof entry === "string" && safeProjectionName.test(entry))
    || new Set(value.projections).size !== value.projections.length
  ) return false;
  return true;
}

function scopedPath(scope: TransactionScope, path: string): string {
  return scope.projectPath === null ? path : `${scope.projectPath}/${path}`;
}

function parentPaths(paths: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path).replaceAll("\\", "/");
    while (parent !== "." && parent !== "/" && parent.length > 0) {
      result.add(parent);
      const next = dirname(parent).replaceAll("\\", "/");
      if (next === parent) break;
      parent = next;
    }
  }
  return result;
}

function allowedTransactionPaths(
  snapshot: TransactionSnapshot,
  transactionPath: string,
): { files: Set<string>; links: Set<string>; directories: Set<string> } {
  const files = new Set<string>();
  const links = new Set<string>();
  for (const scope of snapshot.scopes) {
    const adapterPath = toolConfigAdapters[scope.tool].relativePath.replaceAll("\\", "/");
    files.add(scopedPath(scope, adapterPath));
    files.add(`.saber/runtime/materialize/${scope.tool}/${scope.target}.json`);
    files.add(`.saber/runtime/materialize/${scope.tool}/${scope.target}/context/SKILL.md`);
    files.add(`.saber/runtime/mcp/${scope.tool}/${scope.target}/_active.json`);
    if (snapshot.operation === "materialize") {
      files.add(scopedPath(scope, ".git/info/exclude"));
    }
    for (const id of scope.descriptors) {
      files.add(`.saber/runtime/mcp/${scope.tool}/${scope.target}/${id}.json`);
    }
    for (const name of scope.projections) {
      links.add(scopedPath(scope, `${discoveryDirectories[scope.tool]}/${name}`));
    }
  }
  return {
    files,
    links,
    directories: parentPaths([...files, ...links, transactionPath]),
  };
}

function parseTransaction(text: string, filename: string): TransactionSnapshot {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch {
    throw new SaberError("unresolved lifecycle transaction is invalid", 3);
  }
  const safeFile = (entry: unknown): boolean => isRecord(entry)
    && Object.keys(entry).sort().join(",") === "content,path"
    && typeof entry.path === "string"
    && safeRelativePath(entry.path)
    && (entry.content === null || typeof entry.content === "string");
  const safeLink = (entry: unknown): boolean => isRecord(entry)
    && Object.keys(entry).sort().join(",") === "path,target"
    && typeof entry.path === "string"
    && safeRelativePath(entry.path)
    && (entry.target === null || typeof entry.target === "string");
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "directories,files,links,managedBy,operation,schemaVersion,scopes,target,tool"
    || value.schemaVersion !== 3
    || value.managedBy !== "saber"
    || (value.operation !== "materialize" && value.operation !== "uninstall")
    || (value.tool !== null && value.tool !== "codex" && value.tool !== "claude" && value.tool !== "opencode")
    || (value.target !== null && (typeof value.target !== "string" || !safeTarget.test(value.target)))
    || !Array.isArray(value.scopes)
    || !value.scopes.every(transactionScope)
    || !Array.isArray(value.files)
    || !value.files.every(safeFile)
    || !Array.isArray(value.links)
    || !value.links.every(safeLink)
    || !Array.isArray(value.directories)
    || !value.directories.every((entry) => typeof entry === "string" && safeRelativePath(entry))
  ) throw new SaberError("unresolved lifecycle transaction is invalid", 3);
  const snapshot = value as TransactionSnapshot;
  const materializeName = materializeTransactionName.exec(filename);
  if (snapshot.operation === "materialize") {
    const scope = snapshot.scopes[0];
    if (
      materializeName === null
      || snapshot.scopes.length !== 1
      || scope === undefined
      || snapshot.tool !== materializeName[1]
      || snapshot.target !== materializeName[2]
      || scope.tool !== snapshot.tool
      || scope.target !== snapshot.target
    ) throw new SaberError("unresolved lifecycle transaction is invalid", 3);
  } else {
    const one = snapshot.scopes.length === 1 ? snapshot.scopes[0] : undefined;
    if (
      filename !== "uninstall.json"
      || snapshot.tool !== (one?.tool ?? null)
      || snapshot.target !== (one?.target ?? null)
    ) throw new SaberError("unresolved lifecycle transaction is invalid", 3);
  }
  const relativeTransactionPath = `.saber/runtime/transactions/${filename}`;
  const allowed = allowedTransactionPaths(snapshot, relativeTransactionPath);
  if (
    snapshot.files.some(({ path }) => !allowed.files.has(path))
    || snapshot.links.some(({ path }) => !allowed.links.has(path))
    || snapshot.directories.some((path) => !allowed.directories.has(path))
    || new Set(snapshot.files.map(({ path }) => path)).size !== snapshot.files.length
    || new Set(snapshot.links.map(({ path }) => path)).size !== snapshot.links.length
    || new Set(snapshot.directories).size !== snapshot.directories.length
  ) throw new SaberError("unresolved lifecycle transaction contains a path outside its scope", 3);
  return snapshot;
}

async function writeAtomic(path: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    try { await unlink(path); } catch (error: unknown) { if (!isMissing(error)) throw error; }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.saber-uninstall-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch (error: unknown) { if (!isMissing(error)) throw error; }
  }
}

async function restoreTransaction(
  repositoryRoot: string,
  transactionPath: string,
  snapshot: TransactionSnapshot,
): Promise<void> {
  for (const file of snapshot.files) {
    await assertNoSymlinkParents(repositoryRoot, file.path);
    await writeAtomic(repositoryPath(repositoryRoot, file.path), file.content ?? undefined);
  }
  for (const link of snapshot.links) {
    await assertNoSymlinkParents(repositoryRoot, link.path);
    const path = repositoryPath(repositoryRoot, link.path);
    try { await unlink(path); } catch (error: unknown) { if (!isMissing(error)) throw error; }
    if (link.target !== null) {
      await mkdir(dirname(path), { recursive: true });
      await symlink(link.target, path, "dir");
    }
  }
  try { await unlink(transactionPath); } catch (error: unknown) { if (!isMissing(error)) throw error; }
  for (const directory of [...snapshot.directories].sort((a, b) => b.split("/").length - a.split("/").length)) {
    await assertNoSymlinkParents(repositoryRoot, directory);
    await removeEmptyDirectory(repositoryPath(repositoryRoot, directory));
  }
}

export async function recoverLifecycleTransactions(repositoryRoot: string): Promise<void> {
  const directoryRelative = ".saber/runtime/transactions";
  const directory = repositoryPath(repositoryRoot, directoryRelative);
  let entries: string[];
  try { entries = await readdir(directory); } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  const sorted = entries.sort();
  if (sorted.some((entry) => entry !== "uninstall.json" && !materializeTransactionName.test(entry))) {
    throw new SaberError("lifecycle transaction directory contains unmanaged content", 3);
  }
  const pending: Array<{ path: string; snapshot: TransactionSnapshot }> = [];
  for (const entry of sorted) {
    const relativePath = `${directoryRelative}/${entry}`;
    const text = await readOwnedFile(repositoryRoot, relativePath, "lifecycle transaction");
    pending.push({
      path: repositoryPath(repositoryRoot, relativePath),
      snapshot: parseTransaction(text, entry),
    });
  }
  for (const transaction of pending) {
    await restoreTransaction(repositoryRoot, transaction.path, transaction.snapshot);
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try { await rmdir(path); } catch (error: unknown) {
    if (!isMissing(error) && !isNotEmpty(error)) throw error;
  }
}

async function missingParentDirectories(
  repositoryRoot: string,
  paths: readonly string[],
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path).replaceAll("\\", "/");
    while (parent !== "." && parent !== "/" && parent.length > 0) {
      candidates.add(parent);
      const next = dirname(parent).replaceAll("\\", "/");
      if (next === parent) break;
      parent = next;
    }
  }
  const missing: string[] = [];
  for (const path of [...candidates].sort((a, b) => a.split("/").length - b.split("/").length)) {
    await assertNoSymlinkParents(repositoryRoot, path);
    try {
      await lstat(repositoryPath(repositoryRoot, path));
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      missing.push(path);
    }
  }
  return missing;
}

async function applyPrepared(
  repositoryRoot: string,
  prepared: PreparedPlan,
  dependencies: UninstallDependencies,
): Promise<void> {
  const files = new Map<string, string | null>();
  const links = new Map<string, string | null>();
  for (const target of prepared.targets) {
    files.set(target.plan.toolConfig.path, target.toolConfigText ?? null);
    files.set(target.plan.manifestPath, target.manifestText);
    for (const path of [target.contextFilePath, target.plan.activeIndex, ...target.plan.descriptors]) {
      files.set(path, await readOwnedFile(repositoryRoot, path, "managed uninstall file"));
    }
    for (const link of target.projectionLinks) links.set(link.path, link.target);
  }
  const scopes: TransactionScope[] = prepared.targets.map(({ plan }) => {
    const adapterPath = toolConfigAdapters[plan.tool].relativePath.replaceAll("\\", "/");
    const projectPath = plan.toolConfig.path === adapterPath
      ? null
      : plan.toolConfig.path.endsWith(`/${adapterPath}`)
        ? plan.toolConfig.path.slice(0, -(adapterPath.length + 1))
        : undefined;
    if (projectPath === undefined || (plan.target === "root") !== (projectPath === null)) {
      throw new SaberError("uninstall target has an unsafe tool configuration path", 2);
    }
    return {
      tool: plan.tool,
      target: plan.target,
      projectPath,
      descriptors: plan.descriptors.map((path) => path.slice(path.lastIndexOf("/") + 1, -".json".length)),
      projections: plan.projections.map((path) => path.slice(path.lastIndexOf("/") + 1)),
    };
  });
  const onlyScope = scopes.length === 1 ? scopes[0] : undefined;
  const transaction: TransactionSnapshot = {
    schemaVersion: 3,
    managedBy: "saber",
    operation: "uninstall",
    tool: onlyScope?.tool ?? null,
    target: onlyScope?.target ?? null,
    scopes,
    files: [...files].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path)),
    links: [...links].map(([path, target]) => ({ path, target })).sort((a, b) => a.path.localeCompare(b.path)),
    directories: [],
  };
  const transactionPath = repositoryPath(repositoryRoot, transactionRelativePath);
  transaction.directories = await missingParentDirectories(
    repositoryRoot,
    [...transaction.files.map(({ path }) => path), ...transaction.links.map(({ path }) => path), transactionRelativePath],
  );
  await assertNoSymlinkParents(repositoryRoot, transactionRelativePath);
  await mkdir(dirname(transactionPath), { recursive: true });
  await writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    for (const target of prepared.targets) {
      await dependencies.beforeMutation?.("tool-config", target.plan.toolConfig.path);
      await assertNoSymlinkParents(repositoryRoot, target.plan.toolConfig.path);
      await writeAtomic(
        repositoryPath(repositoryRoot, target.plan.toolConfig.path),
        target.nextToolConfigText,
      );
    }
    for (const target of prepared.targets) {
      for (const link of target.projectionLinks) {
        await dependencies.beforeMutation?.("projection", link.path);
        await unlink(repositoryPath(repositoryRoot, link.path));
      }
      for (const path of [...target.plan.descriptors, target.plan.activeIndex, target.contextFilePath]) {
        await dependencies.beforeMutation?.("runtime", path);
        await unlink(repositoryPath(repositoryRoot, path));
      }
      await dependencies.beforeMutation?.("manifest", target.plan.manifestPath);
      await unlink(repositoryPath(repositoryRoot, target.plan.manifestPath));
      await removeEmptyDirectory(repositoryPath(repositoryRoot, target.plan.contextPath));
      await removeEmptyDirectory(dirname(repositoryPath(repositoryRoot, target.plan.contextPath)));
      await removeEmptyDirectory(dirname(repositoryPath(repositoryRoot, target.plan.activeIndex)));
    }
    await unlink(transactionPath);
    for (const directory of [...transaction.directories].sort((a, b) => b.split("/").length - a.split("/").length)) {
      await removeEmptyDirectory(repositoryPath(repositoryRoot, directory));
    }
  } catch (error: unknown) {
    try {
      await restoreTransaction(repositoryRoot, transactionPath, transaction);
    } catch {
      throw new SaberError("uninstall failed and could not restore the previous state", 3);
    }
    throw error;
  }
}

export async function uninstall(
  repositoryRoot: string,
  request: UninstallRequest,
  dependencies: UninstallDependencies = {},
): Promise<UninstallResult> {
  if (request.confirm !== undefined && request.apply !== true) {
    throw new SaberError("--confirm requires --apply", 2);
  }
  if (request.apply === true && request.confirm === undefined) {
    throw new SaberError("--apply requires --confirm <preview-token>", 2);
  }
  return withRepositoryLifecycleLock(repositoryRoot, async () => {
    await recoverLifecycleTransactions(repositoryRoot);
    if (request.apply !== true) {
      const prepared = await preparePlan(repositoryRoot, request);
      const plan = await issuePreview(repositoryRoot, prepared.content);
      return { applied: false, plan };
    }
    const pending = await findPendingPreview(repositoryRoot, request.confirm!);
    await consumePreview(repositoryRoot, pending);
    const prepared = await preparePlan(repositoryRoot, request);
    if (fingerprint(prepared.content) !== pending.record.planDigest) {
      throw new SaberError("uninstall confirmation token is stale or invalid", 3);
    }
    const plan: UninstallPlan = {
      ...prepared.content,
      confirmationToken: pending.record.token,
    };
    await applyPrepared(repositoryRoot, prepared, dependencies);
    return { applied: true, plan };
  });
}
