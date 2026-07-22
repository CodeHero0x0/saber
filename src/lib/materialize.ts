import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { parse } from "yaml";

import { SaberError } from "./errors.js";
import { resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import { withRepositoryLifecycleLock } from "./lifecycle-lock.js";
import {
  fingerprintMcpValue,
  resolveMcpRuntime,
  writeMcpRuntimeDescriptors,
} from "./mcp/runtime.js";
import type {
  ExternalAssetsConfig,
  RepositoryConfig,
  RoleName,
  RoleProfile,
  ToolName,
} from "./models.js";
import {
  createManagedMcpEntry,
  toolConfigAdapters,
  type ManagedMcpEntry,
} from "./tool-configs/index.js";
import {
  parseRuntimeManifest,
  type MaterializeDescriptor,
  type MaterializeProjection,
  type RuntimeManifest,
} from "./materialize-manifest.js";
import { recoverLifecycleTransactions } from "./uninstall.js";
import { validateRepositoryConfig } from "./validation.js";

type ExternalManifestEntry = {
  id: string;
  category: "skill-collection" | "mcp-server";
  materializedPath: string;
  revision: string | null;
};

export type MaterializeOptions = {
  tool?: ToolName;
  role: RoleName;
  project?: string;
  capabilities?: string[];
};

export type MaterializeResult = RuntimeManifest & {
  manifestPath: string;
  discoveryRoot: string;
};

const toolDiscoveryDirectories: Record<ToolName, string> = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  opencode: ".opencode/skills",
};
const externalManifestPath = ".saber/external/saber-v1/manifest.json";
const runtimeRoot = ".saber/runtime/materialize";
const managedPrefix = "saber--";
const safeId = /^[a-z][a-z0-9-]{0,63}$/u;
const coreCommandSkills = [
  "saber",
  "saber-intake",
  "saber-focus",
  "saber-status",
  "saber-refine",
  "saber-help",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

async function assertNoSymlinkParents(
  repositoryRoot: string,
  relativePath: string,
): Promise<void> {
  resolveWithinRoot(repositoryRoot, relativePath);
  const parts = relativePath.split(/[\\/]+/u);
  let current = resolve(repositoryRoot);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SaberError(`materialize path contains an unsafe parent: ${relativePath}`, 2);
      }
    } catch (error: unknown) {
      if (error instanceof SaberError) throw error;
      if (isMissingPath(error)) return;
      throw error;
    }
  }
}

async function managedWritePath(
  repositoryRoot: string,
  relativePath: string,
  allowLeafSymlink = false,
): Promise<string> {
  resolveWithinRoot(repositoryRoot, relativePath);
  await assertNoSymlinkParents(repositoryRoot, relativePath);
  const path = resolve(repositoryRoot, relativePath);
  if (!allowLeafSymlink) {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new SaberError(`materialize path is an unsafe symbolic link: ${relativePath}`, 2);
      }
    } catch (error: unknown) {
      if (error instanceof SaberError) throw error;
      if (!isMissingPath(error)) throw error;
    }
  }
  return path;
}

function ensureWithin(parent: string, child: string): void {
  const fromParent = relative(parent, child);
  if (
    fromParent === ".." ||
    fromParent.startsWith(`..${sep}`) ||
    fromParent.length === 0 ||
    fromParent.startsWith(sep)
  ) {
    throw new SaberError("materialize path escapes its managed root", 2);
  }
}

function roleProfile(config: RepositoryConfig, role: RoleName): RoleProfile {
  const profile = config.roleProfiles.find((candidate) => candidate.id === role);
  if (profile === undefined) {
    throw new SaberError(`role ${role} is not configured in saber.yaml`, 2);
  }
  return profile;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function selectedCapabilities(
  config: RepositoryConfig,
  profile: RoleProfile,
  requested: readonly string[] | undefined,
  projectName: string | undefined,
): string[] {
  const declared = new Set(config.capabilities.map((capability) => capability.id));
  const values =
    requested !== undefined && requested.length > 0
      ? unique(requested)
      : unique([
          ...profile.capabilities,
          ...(config.local?.extensions.capabilities ?? []),
          ...(config.workspace.tools.defaultCapabilities ?? []),
          ...(projectName === undefined
            ? []
            : (config.workspace.projects.find((project) => project.name === projectName)
                ?.capabilities ?? [])),
        ]);
  for (const capability of values) {
    if (!declared.has(capability)) {
      throw new SaberError(`unknown capability ${capability}`, 2);
    }
  }
  return values;
}

async function requireDirectoryWithSkill(
  repositoryRoot: string,
  relativePath: string,
  label: string,
  expectedName: string,
): Promise<string> {
  try {
    const directory = await resolveExistingPathWithinRoot(repositoryRoot, relativePath);
    const status = await lstat(directory);
    const entrypoint = await resolveExistingPathWithinRoot(
      repositoryRoot,
      `${relativePath}/SKILL.md`,
    );
    const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
      await readFile(entrypoint, "utf8"),
    );
    const frontmatter = frontmatterMatch?.[1] === undefined
      ? undefined
      : parse(frontmatterMatch[1]) as unknown;
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      !(await lstat(entrypoint)).isFile() ||
      !isRecord(frontmatter) ||
      frontmatter.name !== expectedName
    ) {
      throw new Error("invalid package");
    }
    return directory;
  } catch {
    throw new SaberError(`${label} package is missing or invalid`, 2);
  }
}

function parseExternalManifest(text: string): Map<string, ExternalManifestEntry> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new SaberError("external manifest is invalid; run saber external update --apply --confirm", 2);
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.managedBy !== "saber" ||
    !Array.isArray(value.packages)
  ) {
    throw new SaberError("external manifest is not managed by Saber", 2);
  }
  const entries = new Map<string, ExternalManifestEntry>();
  for (const item of value.packages) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      (item.category !== "skill-collection" && item.category !== "mcp-server") ||
      typeof item.materializedPath !== "string" ||
      (typeof item.revision !== "string" && item.revision !== null)
    ) {
      throw new SaberError("external manifest contains an invalid package", 2);
    }
    if (entries.has(item.id)) {
      throw new SaberError("external manifest contains duplicate packages", 2);
    }
    entries.set(item.id, {
      id: item.id,
      category: item.category,
      materializedPath: item.materializedPath,
      revision: item.revision,
    });
  }
  return entries;
}

async function externalEntries(
  repositoryRoot: string,
  ids: readonly string[],
  externalAssets: ExternalAssetsConfig,
): Promise<Array<ExternalManifestEntry & { source: string }>> {
  if (ids.length === 0) {
    return [];
  }
  let manifestText: string;
  try {
    manifestText = await readFile(
      await resolveExistingPathWithinRoot(repositoryRoot, externalManifestPath),
      "utf8",
    );
  } catch {
    throw new SaberError(
      "external skills are missing; run saber external update --apply --confirm",
      2,
    );
  }
  const manifest = parseExternalManifest(manifestText);
  const results: Array<ExternalManifestEntry & { source: string }> = [];
  for (const id of ids) {
    const entry = manifest.get(id);
    const [assetId, packageId, ...extraSegments] = id.split("/");
    const configuredAsset = externalAssets.assets.find((asset) => asset.id === assetId);
    const configuredPackage = configuredAsset?.packages.find(
      (selectedPackage) => selectedPackage.id === packageId,
    );
    const expectedPath =
      configuredAsset === undefined || configuredPackage === undefined
        ? undefined
        : `.saber/external/saber-v1/${configuredAsset.category === "skill-collection" ? "skills" : "mcp"}/${configuredAsset.id}/${configuredPackage.id}`;
    if (
      extraSegments.length > 0 ||
      entry === undefined ||
      entry.category !== "skill-collection" ||
      configuredAsset?.category !== "skill-collection" ||
      expectedPath === undefined ||
      entry.materializedPath !== expectedPath
    ) {
      const asset = assetId ?? id;
      throw new SaberError(
        `external skill ${id} is missing; run saber external update ${asset} --apply --confirm`,
        2,
      );
    }
    let source: string;
    try {
      source = await requireDirectoryWithSkill(
        repositoryRoot,
        entry.materializedPath,
        `external skill ${id}`,
        packageId!,
      );
    } catch {
      const asset = assetId ?? id;
      throw new SaberError(
        `external skill ${id} is missing; run saber external update ${asset} --apply --confirm`,
        2,
      );
    }
    results.push({ ...entry, source });
  }
  return results;
}

function projectionName(kind: MaterializeProjection["kind"], id: string): string {
  const normalized = id.replaceAll("/", "--");
  if (!normalized.split("--").every((part) => safeId.test(part))) {
    throw new SaberError(`unsafe materialize asset id ${id}`, 2);
  }
  return `${managedPrefix}${kind}--${normalized}`;
}

function runtimeManifestRelativePath(tool: ToolName, project: string | undefined): string {
  return `${runtimeRoot}/${tool}/${project ?? "root"}.json`;
}

async function readRuntimeManifest(
  repositoryRoot: string,
  relativePath: string,
): Promise<RuntimeManifest | undefined> {
  try {
    return parseRuntimeManifest(
      await readFile(await resolveExistingPathWithinRoot(repositoryRoot, relativePath), "utf8"),
    );
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return undefined;
    }
    if (error instanceof SaberError) {
      throw error;
    }
    throw new SaberError("materialize runtime manifest is invalid", 2);
  }
}

type ProjectionBackup = {
  path: string;
  target: string;
};

function managedProjectionPath(
  targetRoot: string,
  discoveryRelativePath: string,
  projection: MaterializeProjection,
): string {
  if (
    !projection.name.startsWith(managedPrefix) ||
    projection.linkPath !== `${discoveryRelativePath}/${projection.name}`
  ) {
    throw new SaberError("materialize runtime manifest contains an unsafe projection", 2);
  }
  const root = resolve(targetRoot);
  const path = resolve(root, projection.linkPath);
  const fromRoot = relative(root, path);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    !projection.linkPath.split(/[\\/]+/u).every((part) => part !== "..")
  ) {
    throw new SaberError("materialize runtime manifest contains an unsafe projection", 2);
  }
  return path;
}

async function snapshotManagedProjection(
  targetRoot: string,
  discoveryRelativePath: string,
  projection: MaterializeProjection,
): Promise<ProjectionBackup | undefined> {
  const path = managedProjectionPath(targetRoot, discoveryRelativePath, projection);
  try {
    const status = await lstat(path);
    if (!status.isSymbolicLink()) {
      throw new SaberError(
        `managed projection ${projection.linkPath} was replaced; remove it manually`,
        2,
      );
    }
    return { path, target: await readlink(path) };
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

async function removeManagedProjection(
  targetRoot: string,
  discoveryRelativePath: string,
  projection: MaterializeProjection,
): Promise<void> {
  const path = managedProjectionPath(targetRoot, discoveryRelativePath, projection);
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
}

async function preflightProjectionDestinations(
  targetRoot: string,
  discoveryRelativePath: string,
  names: readonly string[],
  previousPaths: ReadonlySet<string>,
): Promise<void> {
  const discoveryRoot = resolve(targetRoot, discoveryRelativePath);
  for (const name of names) {
    const path = resolve(discoveryRoot, name);
    ensureWithin(discoveryRoot, path);
    try {
      await lstat(path);
      if (!previousPaths.has(path)) {
        throw new SaberError(`tool projection ${name} already exists and is not managed by this run`, 2);
      }
    } catch (error: unknown) {
      if (error instanceof SaberError) {
        throw error;
      }
      if (!isMissingPath(error)) {
        throw new SaberError("could not inspect tool projection destinations", 2);
      }
    }
  }
}

async function restoreProjectionBackups(backups: readonly ProjectionBackup[]): Promise<void> {
  for (const backup of backups) {
    try {
      await lstat(backup.path);
      continue;
    } catch (error: unknown) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    await symlink(backup.target, backup.path, "dir");
  }
}

async function createProjection(
  targetRoot: string,
  discoveryRelativePath: string,
  name: string,
  source: string,
): Promise<MaterializeProjection> {
  const discoveryRoot = resolveWithinRoot(targetRoot, discoveryRelativePath);
  await mkdir(discoveryRoot, { recursive: true });
  const linkPath = resolveWithinRoot(targetRoot, `${discoveryRelativePath}/${name}`);
  ensureWithin(discoveryRoot, linkPath);
  try {
    await lstat(linkPath);
    throw new SaberError(`tool projection ${name} already exists and is not managed by this run`, 2);
  } catch (error: unknown) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }
  await symlink(relative(dirname(linkPath), source), linkPath, "dir");
  const linked = await realpath(linkPath);
  if (linked !== (await realpath(source))) {
    await unlink(linkPath);
    throw new SaberError(`tool projection ${name} did not resolve to its approved source`, 2);
  }
  const kind: MaterializeProjection["kind"] = name.includes("--context--")
      ? "context"
      : name.includes("--core-command--")
        ? "core-command"
        : name.includes("--personal-prompt--")
          ? "personal-prompt"
          : name.includes("--workflow--")
            ? "workflow"
            : name.includes("--external-skill--")
              ? "external-skill"
              : "team-skill";
  return {
    name,
    kind,
    linkPath: `${discoveryRelativePath}/${name}`,
    sourcePath: source,
    sourceDigest: kind === "context"
      ? rawDigest(await readFile(join(source, "SKILL.md"), "utf8"))
      : null,
    linkTarget: relative(dirname(linkPath), source),
  };
}

function contextSkillContent(
  profile: RoleProfile,
  capabilities: readonly string[],
  project: string | undefined,
): string {
  return `---\nname: saber-context-${profile.id}\ndescription: Use at the start of Saber work as the active ${profile.id.toUpperCase()} role context.\n---\n\n# Saber ${profile.id.toUpperCase()} context\n\n- Role: ${profile.id}\n- Project: ${project ?? "cross-repository workspace"}\n- Capabilities: ${capabilities.join(", ")}\n- Team skills: ${profile.teamSkills.join(", ")}\n- External skills: ${profile.externalSkills.join(", ")}\n- Workflows: ${profile.workflows.join(", ")}\n\nSaber CLI 是供已物化技能调用的内部接口。当前默认角色只是无明确意图或工作项责任角色时的路由上下文，不是授权；实际角色由用户意图和工作项状态决定。MCP 和能力只能来自团队或个人已批准配置。L2 外部写入必须先 preview 并取得精确确认；MVP 禁止 L3 操作。按需读取已链接的角色、工作流和技能包。\n`;
}

async function writeContextPackage(
  repositoryRoot: string,
  tool: ToolName,
  project: string | undefined,
  profile: RoleProfile,
  capabilities: readonly string[],
): Promise<string> {
  const relativePath = `${runtimeRoot}/${tool}/${project ?? "root"}/context`;
  const path = resolveWithinRoot(repositoryRoot, relativePath);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    contextSkillContent(profile, capabilities, project),
    { encoding: "utf8", mode: 0o600 },
  );
  return path;
}

async function ensureLocalGitExclude(
  targetRoot: string,
  discoveryRelativePath: string,
): Promise<void> {
  const gitDirectory = resolve(targetRoot, ".git");
  try {
    if (!(await lstat(gitDirectory)).isDirectory()) {
      return;
    }
  } catch {
    return;
  }
  const excludePath = join(gitDirectory, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error: unknown) {
    if (!isMissingPath(error)) {
      throw new SaberError("could not inspect project-local Git exclude", 2);
    }
  }
  const pattern = `/${discoveryRelativePath}/${managedPrefix}*`;
  if (!existing.split(/\r?\n/u).includes(pattern)) {
    await appendFile(excludePath, `${existing.length === 0 || existing.endsWith("\n") ? "" : "\n"}${pattern}\n`, "utf8");
  }
}

async function writeRuntimeManifest(
  repositoryRoot: string,
  relativePath: string,
  manifest: RuntimeManifest,
): Promise<void> {
  const path = await managedWritePath(repositoryRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.saber-materialize-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } finally {
    try { await unlink(temporaryPath); } catch (error: unknown) { if (!isMissingPath(error)) throw error; }
  }
}

function rawDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, text: string | undefined): Promise<void> {
  if (text === undefined) {
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.saber-materialize-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    try { await unlink(temporaryPath); } catch (error: unknown) { if (!isMissingPath(error)) throw error; }
  }
}

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
  operation: "materialize";
  tool: ToolName;
  target: string;
  scopes: [TransactionScope];
  files: TransactionFile[];
  links: TransactionLink[];
  directories: string[];
};

function transactionPath(repositoryRoot: string, tool: ToolName, target: string): string {
  return resolveWithinRoot(repositoryRoot, `.saber/runtime/transactions/materialize--${tool}--${target}.json`);
}

async function writeTransaction(path: string, snapshot: TransactionSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
    const absolute = await managedWritePath(repositoryRoot, path);
    try {
      await lstat(absolute);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      missing.push(path);
    }
  }
  return missing;
}

async function cleanupSnapshotDirectories(
  repositoryRoot: string,
  directories: readonly string[],
): Promise<void> {
  for (const directory of [...directories].sort((a, b) => b.split("/").length - a.split("/").length)) {
    const path = await managedWritePath(repositoryRoot, directory);
    try {
      await rmdir(path);
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (!isMissingPath(error) && code !== "ENOTEMPTY") throw error;
    }
  }
}

function repositoryRelativePath(repositoryRoot: string, path: string): string {
  const lexical = relative(resolve(repositoryRoot), resolve(path)).replaceAll(sep, "/");
  const canonical = relative(realpathSync(repositoryRoot), resolve(path)).replaceAll(sep, "/");
  const value = lexical !== ".." && !lexical.startsWith("../") ? lexical : canonical;
  if (value.length === 0 || value === ".." || value.startsWith("../")) {
    throw new SaberError("materialize transaction path escapes the repository", 3);
  }
  return value;
}

async function restoreTransaction(
  repositoryRoot: string,
  path: string,
  snapshot: TransactionSnapshot,
): Promise<void> {
  for (const file of snapshot.files) {
    await writeAtomic(
      await managedWritePath(repositoryRoot, file.path),
      file.content ?? undefined,
    );
  }
  for (const link of snapshot.links) {
    const linkPath = await managedWritePath(repositoryRoot, link.path, true);
    try { await unlink(linkPath); } catch (error: unknown) { if (!isMissingPath(error)) throw error; }
    if (link.target !== null) {
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(link.target, linkPath, "dir");
    }
  }
  await unlink(path).catch((error: unknown) => { if (!isMissingPath(error)) throw error; });
  await cleanupSnapshotDirectories(repositoryRoot, snapshot.directories);
}

async function snapshotRuntimeDirectory(repositoryRoot: string, tool: ToolName, target: string): Promise<TransactionFile[]> {
  const directory = resolveWithinRoot(repositoryRoot, `.saber/runtime/mcp/${tool}/${target}`);
  let entries: string[];
  try { entries = await readdir(directory); } catch (error: unknown) { if (isMissingPath(error)) return []; throw error; }
  const files: TransactionFile[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SaberError("managed MCP runtime contains invalid content", 2);
    files.push({ path: repositoryRelativePath(repositoryRoot, path), content: await readFile(path, "utf8") });
  }
  return files;
}

/** Materialize only one role's approved assets into a tool-native discovery directory. */
async function materializeLocked(
  repositoryRoot: string,
  config: RepositoryConfig,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  await recoverLifecycleTransactions(repositoryRoot);
  const validationErrors = validateRepositoryConfig(config);
  if (validationErrors.length > 0) {
    throw new SaberError(`saber.yaml is invalid: ${validationErrors.join("; ")}`, 2);
  }
  const profile = roleProfile(config, options.role);
  const tool = options.tool ?? config.workspace.tools.default;
  if (!(config.workspace.tools.supported ?? [config.workspace.tools.default]).includes(tool)) {
    throw new SaberError(`tool ${tool} is not enabled in saber.yaml`, 2);
  }

  let targetRoot = repositoryRoot;
  let projectRelativePath: string | undefined;
  if (options.project !== undefined) {
    const project = config.workspace.projects.find((candidate) => candidate.name === options.project);
    if (project === undefined) {
      throw new SaberError(`unknown project ${options.project}`, 2);
    }
    try {
      targetRoot = await resolveExistingPathWithinRoot(repositoryRoot, project.path);
      projectRelativePath = project.path;
      if (!(await lstat(targetRoot)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new SaberError(
        `project ${options.project} is missing; run saber init --apply --confirm first`,
        2,
      );
    }
  }

  const target = options.project ?? "root";
  const capabilities = selectedCapabilities(
    config,
    profile,
    options.capabilities,
    options.project,
  );
  const coreSources = await Promise.all(
    coreCommandSkills.map(async (id) => ({
      id,
      source: await requireDirectoryWithSkill(
        repositoryRoot,
        `skills/${id}`,
        `core command ${id}`,
        id,
      ),
    })),
  );
  const effectiveTeamSkills = unique([
    ...profile.teamSkills,
    ...(config.local?.extensions.skills ?? []),
  ]).filter((id) => !(coreCommandSkills as readonly string[]).includes(id));
  const teamSources = await Promise.all(
    effectiveTeamSkills.map(async (id) => ({
      id,
      source: await requireDirectoryWithSkill(
        repositoryRoot,
        `skills/${id}`,
        `team skill ${id}`,
        id,
      ),
    })),
  );
  const promptIds = unique(config.local?.extensions.prompts ?? []);
  const promptSources = await Promise.all(
    promptIds.map(async (id) => ({
      id,
      source: await requireDirectoryWithSkill(
        repositoryRoot,
        `prompts/${id}`,
        `personal prompt ${id}`,
        id,
      ),
    })),
  );
  const workflowSources = await Promise.all(
    profile.workflows.map(async (id) => ({
      id,
      source: await requireDirectoryWithSkill(
        repositoryRoot,
        `workflows/${id}`,
        `workflow ${id}`,
        id,
      ),
    })),
  );
  const externalSources = await externalEntries(
    repositoryRoot,
    profile.externalSkills,
    config.externalAssets,
  );

  const discoveryRelativePath = toolDiscoveryDirectories[tool];
  const manifestRelativePath = runtimeManifestRelativePath(tool, options.project);
  const previous = await readRuntimeManifest(repositoryRoot, manifestRelativePath);
  if (
    previous !== undefined &&
    (previous.tool !== tool || previous.target !== target || previous.project !== (options.project ?? null))
  ) {
    throw new SaberError("materialize runtime manifest does not match its managed target", 2);
  }

  const effectiveProfile: RoleProfile = {
    ...profile,
    teamSkills: effectiveTeamSkills,
  };
  const contextSource = resolveWithinRoot(
    repositoryRoot,
    `${runtimeRoot}/${tool}/${options.project ?? "root"}/context`,
  );
  const sources: Array<{ name: string; source: string }> = [
    { name: projectionName("context", profile.id), source: contextSource },
    ...coreSources.map((asset) => ({
      name: projectionName("core-command", asset.id),
      source: asset.source,
    })),
    ...teamSources.map((asset) => ({
      name: projectionName("team-skill", asset.id),
      source: asset.source,
    })),
    ...promptSources.map((asset) => ({
      name: projectionName("personal-prompt", asset.id),
      source: asset.source,
    })),
    ...workflowSources.map((asset) => ({
      name: projectionName("workflow", asset.id),
      source: asset.source,
    })),
    ...externalSources.map((asset) => ({
      name: projectionName("external-skill", asset.id),
      source: asset.source,
    })),
  ];
  const backups: ProjectionBackup[] = [];
  if (previous !== undefined) {
    for (const projection of previous.projections) {
      const backup = await snapshotManagedProjection(targetRoot, discoveryRelativePath, projection);
      if (backup === undefined) throw new SaberError(`managed projection ${projection.linkPath} is missing`, 2);
      if (await realpath(backup.path) !== await realpath(resolve(repositoryRoot, projection.sourcePath))) {
        throw new SaberError(`managed projection ${projection.linkPath} was redirected; remove it manually`, 2);
      }
      if (backup.target !== projection.linkTarget) {
        throw new SaberError(`managed projection ${projection.linkPath} was changed; remove it manually`, 2);
      }
      if (projection.kind === "context") {
        const contextText = await readOptional(
          resolve(repositoryRoot, projection.sourcePath, "SKILL.md"),
        );
        if (contextText === undefined || rawDigest(contextText) !== projection.sourceDigest) {
          throw new SaberError("managed context runtime does not match its manifest", 2);
        }
      }
      backups.push(backup);
    }
  }
  await preflightProjectionDestinations(
    targetRoot,
    discoveryRelativePath,
    sources.map(({ name }) => name),
    new Set(backups.map(({ path }) => path)),
  );

  const resolvedMcp = resolveMcpRuntime(repositoryRoot, config, {
    tool,
    target,
    project: options.project,
    capabilities,
  });

  const adapter = toolConfigAdapters[tool];
  const toolConfigRepoPath = `${projectRelativePath === undefined ? "" : `${projectRelativePath.replaceAll("\\", "/")}/`}${adapter.relativePath}`;
  const toolConfigPath = await managedWritePath(repositoryRoot, toolConfigRepoPath);
  const oldToolConfigText = await readOptional(toolConfigPath);
  const oldManifestText = await readOptional(resolveWithinRoot(repositoryRoot, manifestRelativePath));
  const descriptorDirectory = resolveWithinRoot(repositoryRoot, `.saber/runtime/mcp/${tool}/${target}`);
  const oldRuntimeFiles = await snapshotRuntimeDirectory(repositoryRoot, tool, target);
  if (previous !== undefined) {
    if (
      previous.toolConfig.path !== toolConfigRepoPath
      || previous.activeIndex.path !== `.saber/runtime/mcp/${tool}/${target}/_active.json`
      || previous.descriptors.some((descriptor) =>
        descriptor.path !== `.saber/runtime/mcp/${tool}/${target}/${descriptor.id}.json`)
    ) {
      throw new SaberError("materialize runtime manifest contains an unsafe managed path", 2);
    }
    const activeText = await readOptional(resolveWithinRoot(repositoryRoot, previous.activeIndex.path));
    if (activeText === undefined || rawDigest(activeText) !== previous.activeIndex.digest) {
      throw new SaberError("managed MCP active index does not match its manifest", 2);
    }
    for (const descriptor of previous.descriptors) {
      const text = await readOptional(resolveWithinRoot(repositoryRoot, descriptor.path));
      if (text === undefined || rawDigest(text) !== descriptor.digest) {
        throw new SaberError(`managed MCP descriptor ${descriptor.id} does not match its manifest`, 2);
      }
    }
    adapter.verify(adapter.inspect(oldToolConfigText), previous.mcpEntries);
  }
  const contextFile = join(contextSource, "SKILL.md");
  const excludePath = join(resolve(targetRoot, ".git"), "info", "exclude");
  const files: TransactionFile[] = [
    { path: repositoryRelativePath(repositoryRoot, toolConfigPath), content: oldToolConfigText ?? null },
    { path: manifestRelativePath, content: oldManifestText ?? null },
    { path: repositoryRelativePath(repositoryRoot, contextFile), content: await readOptional(contextFile) ?? null },
    { path: repositoryRelativePath(repositoryRoot, excludePath), content: await readOptional(excludePath) ?? null },
    ...oldRuntimeFiles,
  ];
  const descriptorIds = resolvedMcp.descriptors.map((descriptor) => descriptor.server.id);
  for (const id of descriptorIds) {
    const path = join(descriptorDirectory, `${id}.json`);
    const relativePath = repositoryRelativePath(repositoryRoot, path);
    if (!files.some((file) => file.path === relativePath)) {
      files.push({ path: relativePath, content: await readOptional(path) ?? null });
    }
  }
  const activeIndexPath = join(descriptorDirectory, "_active.json");
  const activeIndexRelativePath = repositoryRelativePath(repositoryRoot, activeIndexPath);
  if (!files.some((file) => file.path === activeIndexRelativePath)) {
    files.push({ path: activeIndexRelativePath, content: await readOptional(activeIndexPath) ?? null });
  }
  const links: TransactionLink[] = [];
  for (const projection of [...(previous?.projections ?? []), ...sources.map(({ name }) => ({
    name,
    kind: "team-skill" as const,
    linkPath: `${discoveryRelativePath}/${name}`,
    sourcePath: "skills",
    sourceDigest: null,
    linkTarget: "",
  }))]) {
    const path = resolve(targetRoot, projection.linkPath);
    if (links.some((link) => link.path === path)) continue;
    links.push({
      path: repositoryRelativePath(repositoryRoot, path),
      target: await readlink(path).catch((error: unknown) => isMissingPath(error) ? null : Promise.reject(error)),
    });
  }
  const transactionFile = transactionPath(repositoryRoot, tool, target);
  const transactionRelative = repositoryRelativePath(repositoryRoot, transactionFile);
  const directories = await missingParentDirectories(
    repositoryRoot,
    [...files.map(({ path }) => path), ...links.map(({ path }) => path), transactionRelative],
  );
  const transaction: TransactionSnapshot = {
    schemaVersion: 3,
    managedBy: "saber",
    operation: "materialize",
    tool,
    target,
    scopes: [{
      tool,
      target,
      projectPath: projectRelativePath ?? null,
      descriptors: [...new Set(files.flatMap(({ path }) => {
        const match = new RegExp(
          `^\\.saber/runtime/mcp/${tool}/${target}/([a-z][a-z0-9-]{0,63})\\.json$`,
          "u",
        ).exec(path);
        return match?.[1] === undefined ? [] : [match[1]];
      }))].sort(),
      projections: [...new Set(links.map(({ path }) => path.slice(path.lastIndexOf("/") + 1)))].sort(),
    }],
    files,
    links,
    directories,
  };
  await writeTransaction(transactionFile, transaction);

  const projections: MaterializeProjection[] = [];
  let finalToolConfigText: string | undefined;
  let desiredEntries: ManagedMcpEntry[] = [];
  try {
    await ensureLocalGitExclude(targetRoot, discoveryRelativePath);
    await writeContextPackage(
      repositoryRoot,
      tool,
      options.project,
      effectiveProfile,
      capabilities,
    );
    for (const projection of previous?.projections ?? []) {
      await removeManagedProjection(targetRoot, discoveryRelativePath, projection);
    }
    for (const source of sources) {
      projections.push(
        await createProjection(targetRoot, discoveryRelativePath, source.name, source.source),
      );
    }

    await writeMcpRuntimeDescriptors(repositoryRoot, resolvedMcp);
    const descriptorRecords: MaterializeDescriptor[] = [];
    for (const descriptor of resolvedMcp.descriptors) {
      const path = `.saber/runtime/mcp/${tool}/${target}/${descriptor.server.id}.json`;
      const text = await readFile(resolveWithinRoot(repositoryRoot, path), "utf8");
      descriptorRecords.push({
        id: descriptor.server.id,
        path,
        digest: rawDigest(text),
        descriptorFingerprint: descriptor.descriptorFingerprint,
        sourceFingerprint: descriptor.sourceFingerprint,
      });
      desiredEntries.push(createManagedMcpEntry(`saber--${descriptor.server.id}`, {
        command: process.execPath,
        args: [resolve(repositoryRoot, "dist/cli.js"), "mcp", "bridge", "--descriptor", path],
        cwd: repositoryRoot,
      }));
    }
    const currentSnapshot = adapter.inspect(oldToolConfigText);
    if (previous !== undefined) adapter.verify(currentSnapshot, previous.mcpEntries);
    const withoutPrevious = previous === undefined || previous.mcpEntries.length === 0
      ? oldToolConfigText
      : adapter.remove(currentSnapshot, previous.mcpEntries);
    const baseSnapshot = adapter.inspect(withoutPrevious === null ? undefined : withoutPrevious);
    if (desiredEntries.length === 0) {
      finalToolConfigText = withoutPrevious === null
        ? (previous?.toolConfig.createdBySaber === true ? undefined : "")
        : withoutPrevious;
    } else {
      finalToolConfigText = adapter.render(baseSnapshot, desiredEntries);
    }
    await writeAtomic(toolConfigPath, finalToolConfigText);
    const activeText = await readFile(join(descriptorDirectory, "_active.json"), "utf8");
    const teamConfig = { ...config } as Record<string, unknown>;
    delete teamConfig.local;
    const teamSourceText = await readOptional(resolveWithinRoot(repositoryRoot, "saber.yaml"));
    const localSourceText = await readOptional(resolveWithinRoot(repositoryRoot, "saber.local.yaml"));
    let externalText: string | undefined;
    try { externalText = await readFile(resolveWithinRoot(repositoryRoot, externalManifestPath), "utf8"); } catch (error: unknown) { if (!isMissingPath(error)) throw error; }
    const manifest: RuntimeManifest = {
      schemaVersion: 3,
      managedBy: "saber",
      tool,
      target,
      role: profile.id,
      project: options.project ?? null,
      capabilities,
      coreCommands: [...coreCommandSkills],
      teamSkills: [...effectiveProfile.teamSkills],
      prompts: promptIds,
      externalSkills: [...profile.externalSkills],
      workflows: [...profile.workflows],
      projections: projections.map((projection) => ({
        ...projection,
        sourcePath: repositoryRelativePath(repositoryRoot, projection.sourcePath),
        linkTarget: projection.linkTarget,
      })),
      mcpServers: descriptorRecords.map(({ id }) => id),
      mcpEntries: desiredEntries,
      descriptors: descriptorRecords,
      activeIndex: { path: activeIndexRelativePath, digest: rawDigest(activeText) },
      toolConfig: {
        path: toolConfigRepoPath,
        existedBefore: oldToolConfigText !== undefined,
        createdBySaber: previous?.toolConfig.createdBySaber
          ?? (oldToolConfigText === undefined && finalToolConfigText !== undefined),
        digest: finalToolConfigText === undefined ? null : rawDigest(finalToolConfigText),
      },
      sourceFingerprints: {
        team: fingerprintMcpValue(teamSourceText ?? teamConfig),
        local: config.local === undefined
          ? null
          : fingerprintMcpValue(localSourceText ?? config.local),
        external: externalText === undefined ? null : fingerprintMcpValue(externalText),
      },
    };
    await writeRuntimeManifest(repositoryRoot, manifestRelativePath, manifest);
    await unlink(transactionFile);
    await cleanupSnapshotDirectories(repositoryRoot, directories);
    return {
      ...manifest,
      manifestPath: manifestRelativePath,
      discoveryRoot:
        projectRelativePath === undefined
          ? discoveryRelativePath
          : `${projectRelativePath.replaceAll("\\", "/")}/${discoveryRelativePath}`,
    };
  } catch (error: unknown) {
    try {
      await restoreTransaction(repositoryRoot, transactionFile, transaction);
    } catch {
      throw new SaberError("materialize failed and could not restore the previous transaction", 3);
    }
    throw error;
  }
}

export async function materialize(
  repositoryRoot: string,
  config: RepositoryConfig,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  return withRepositoryLifecycleLock(
    repositoryRoot,
    () => materializeLocked(repositoryRoot, config, options),
  );
}
