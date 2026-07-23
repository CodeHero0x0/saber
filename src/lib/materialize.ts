import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { parse } from "yaml";

import { SaberError } from "./errors.js";
import { resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import { withRepositoryLifecycleLock } from "./lifecycle-lock.js";
import type { McpServerConfig, RepositoryConfig, ToolName } from "./models.js";
import {
  createManagedMcpEntry,
  toolConfigAdapters,
  type ManagedMcpEntry,
} from "./tool-configs/index.js";
import {
  parseRuntimeManifest,
  type MaterializeProjection,
  type ProjectionKind,
  type RuntimeManifest,
} from "./materialize-manifest.js";
import { validateRepositoryConfig } from "./validation.js";

export type MaterializeOptions = {
  tool?: ToolName;
  project?: string;
  capabilities?: string[];
};

export type MaterializeResult = RuntimeManifest & {
  manifestPath: string;
  discoveryRoot: string;
};

type Source = { name: string; kind: ProjectionKind; path: string };
type ExternalManifest = {
  schemaVersion: 1;
  managedBy: "saber";
  packages: Array<{ id: string; category: string; materializedPath: string }>;
};

const discoveryDirectories: Record<ToolName, string> = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  opencode: ".opencode/skills",
};
const coreCommands = ["saber"] as const;
const managedPrefix = "saber--";
const safeId = /^[a-z][a-z0-9-]{0,63}$/u;
const externalManifestPath = ".saber/external/saber-v1/manifest.json";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(value: unknown): string {
  return `sha256:${digest(typeof value === "string" ? value : JSON.stringify(value))}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

async function assertNoSymlinkParents(root: string, relativePath: string): Promise<void> {
  let current = resolve(root);
  const parts = relativePath.split(/[\\/]+/u);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SaberError(`managed path contains an unsafe parent: ${relativePath}`, 2);
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      return;
    }
  }
}

async function managedFilePath(root: string, relativePath: string): Promise<string> {
  await assertNoSymlinkParents(root, relativePath);
  const path = resolveWithinRoot(root, relativePath);
  try {
    const status = await lstat(resolve(root, relativePath));
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new SaberError(`managed file path is unsafe: ${relativePath}`, 2);
    }
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  return path;
}

async function managedLinkPath(root: string, relativePath: string): Promise<string> {
  await assertNoSymlinkParents(root, relativePath);
  const path = resolveWithinRoot(root, relativePath);
  try {
    await lstat(resolve(root, relativePath));
    throw new SaberError(`managed projection already exists: ${relativePath}`, 2);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  return path;
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error: unknown) { if (isMissing(error)) return undefined; throw error; }
}

async function writeAtomic(path: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    try { await unlink(path); } catch (error: unknown) { if (!isMissing(error)) throw error; }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.saber-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch (error: unknown) { if (!isMissing(error)) throw error; }
  }
}

function projectionName(kind: ProjectionKind, id: string): string {
  const normalized = id.replaceAll("/", "--");
  if (!normalized.split("--").every((part) => safeId.test(part))) {
    throw new SaberError(`invalid ${kind} id ${id}`, 2);
  }
  return `${managedPrefix}${kind}--${normalized}`;
}

async function requireSkillDirectory(root: string, path: string, label: string): Promise<string> {
  try {
    await assertNoSymlinkParents(root, `${path}/SKILL.md`);
    const lexicalDirectory = resolve(root, path);
    const lexicalSkill = resolve(root, `${path}/SKILL.md`);
    if ((await lstat(lexicalDirectory)).isSymbolicLink() || (await lstat(lexicalSkill)).isSymbolicLink()) {
      throw new Error();
    }
    const directory = await resolveExistingPathWithinRoot(root, path);
    const status = await lstat(directory);
    const skill = await resolveExistingPathWithinRoot(root, `${path}/SKILL.md`);
    if (!status.isDirectory() || status.isSymbolicLink() || !(await lstat(skill)).isFile()) throw new Error();
    return directory;
  } catch {
    throw new SaberError(`${label} is missing or invalid`, 2);
  }
}

async function loadExternalManifest(root: string): Promise<ExternalManifest> {
  let value: unknown;
  try { value = JSON.parse(await readFile(resolveWithinRoot(root, externalManifestPath), "utf8")); } catch { throw new SaberError("external skills are missing; run saber init again", 2); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SaberError("external skill manifest is invalid", 2);
  const manifest = value as Partial<ExternalManifest>;
  if (manifest.schemaVersion !== 1 || manifest.managedBy !== "saber" || !Array.isArray(manifest.packages)) {
    throw new SaberError("external skill manifest is invalid", 2);
  }
  return manifest as ExternalManifest;
}

async function externalSources(root: string, ids: readonly string[]): Promise<Source[]> {
  if (ids.length === 0) return [];
  const manifest = await loadExternalManifest(root);
  return Promise.all(unique(ids).map(async (id) => {
    const entry = manifest.packages.find((candidate) => candidate.id === id && candidate.category === "skill-collection");
    if (entry === undefined) throw new SaberError(`external skill ${id} is not installed`, 2);
    return {
      name: projectionName("external-skill", id),
      kind: "external-skill" as const,
      path: await requireSkillDirectory(root, entry.materializedPath, `external skill ${id}`),
    };
  }));
}

function selectedCapabilities(config: RepositoryConfig, project: string | undefined, requested: readonly string[] | undefined): string[] {
  const declared = new Set(config.capabilities.map(({ id }) => id));
  const selected = unique(requested?.length
    ? requested
    : [
        ...config.roleProfiles.flatMap(({ capabilities }) => capabilities),
        ...(config.workspace.tools.defaultCapabilities ?? []),
        ...(config.local?.extensions.capabilities ?? []),
        ...(project === undefined ? [] : config.workspace.projects.find(({ name }) => name === project)?.capabilities ?? []),
      ]);
  for (const id of selected) if (!declared.has(id)) throw new SaberError(`unknown capability ${id}`, 2);
  return selected;
}

function claudeEnvironmentReferences(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map((name) => [name, `\${${name}}`]));
}

function claudeHeaderReferences(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([name, source]) => [name, `\${${source}}`]));
}

function opencodeEnvironmentReferences(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map((name) => [name, `{env:${name}}`]));
}

function opencodeHeaderReferences(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([name, source]) => [name, `{env:${source}}`]));
}

function nativeMcpValue(tool: ToolName, server: McpServerConfig): unknown {
  if (server.transport === "stdio") {
    if (tool === "codex") {
      return {
        command: server.command,
        args: server.args,
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        ...(server.env.length === 0 ? {} : { env_vars: server.env }),
      };
    }
    if (tool === "opencode") {
      return {
        type: "local",
        command: [server.command, ...server.args],
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        ...(server.env.length === 0 ? {} : { environment: opencodeEnvironmentReferences(server.env) }),
      };
    }
    return {
      command: server.command,
      args: server.args,
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.env.length === 0 ? {} : { env: claudeEnvironmentReferences(server.env) }),
    };
  }
  if (tool === "codex") {
    return {
      url: server.url,
      ...(Object.keys(server.headers).length === 0 ? {} : { env_http_headers: server.headers }),
    };
  }
  const headers = tool === "opencode"
    ? opencodeHeaderReferences(server.headers)
    : claudeHeaderReferences(server.headers);
  return {
    type: tool === "opencode" ? "remote" : "http",
    url: server.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

function mcpEntries(config: RepositoryConfig, tool: ToolName, capabilities: readonly string[]): ManagedMcpEntry[] {
  const allowed = new Set(capabilities);
  const explicit = new Set(config.local?.extensions.mcpServers ?? []);
  const servers = [...config.mcp.servers, ...(config.local?.mcp.servers ?? [])];
  return servers.flatMap((server) => {
    const selected = explicit.has(server.id) || server.tools.some(({ capability }) => allowed.has(capability));
    return selected ? [createManagedMcpEntry(`saber--${server.id}`, nativeMcpValue(tool, server))] : [];
  });
}

async function ensureGitExclude(targetRoot: string, discovery: string): Promise<void> {
  const git = resolve(targetRoot, ".git");
  try { if (!(await lstat(git)).isDirectory()) return; } catch { return; }
  const path = await managedFilePath(targetRoot, ".git/info/exclude");
  await mkdir(dirname(path), { recursive: true });
  const content = await readOptional(path) ?? "";
  const pattern = `/${discovery}/${managedPrefix}*`;
  if (!content.split(/\r?\n/u).includes(pattern)) {
    await appendFile(path, `${content.length === 0 || content.endsWith("\n") ? "" : "\n"}${pattern}\n`, "utf8");
  }
}

async function removeProjection(root: string, projection: MaterializeProjection): Promise<void> {
  await assertNoSymlinkParents(root, projection.linkPath);
  const path = resolve(root, projection.linkPath);
  const status = await lstat(path).catch(() => undefined);
  if (status === undefined) return;
  if (!status.isSymbolicLink() || await readlink(path) !== projection.linkTarget) {
    throw new SaberError(`managed projection ${projection.linkPath} was changed`, 2);
  }
  await unlink(path);
}

async function createProjection(
  repositoryRoot: string,
  targetRoot: string,
  discovery: string,
  source: Source,
): Promise<MaterializeProjection> {
  const relativeLinkPath = `${discovery}/${source.name}`;
  const linkPath = await managedLinkPath(targetRoot, relativeLinkPath);
  await mkdir(dirname(linkPath), { recursive: true });
  const target = relative(dirname(linkPath), source.path);
  await symlink(target, linkPath, "dir");
  return {
    name: source.name,
    kind: source.kind,
    linkPath: `${discovery}/${source.name}`,
    sourcePath: relative(await realpath(repositoryRoot), source.path).replaceAll("\\", "/"),
    sourceDigest: null,
    linkTarget: target,
  };
}

function manifestPath(tool: ToolName, project: string | undefined): string {
  return `.saber/runtime/materialize/${tool}/${project ?? "root"}.json`;
}

async function readPrevious(root: string, path: string): Promise<RuntimeManifest | undefined> {
  const text = await readOptional(await managedFilePath(root, path));
  return text === undefined ? undefined : parseRuntimeManifest(text);
}

/** Install the same Saber command and stage assets for every team member. */
async function materializeLocked(root: string, config: RepositoryConfig, options: MaterializeOptions): Promise<MaterializeResult> {
  const errors = validateRepositoryConfig(config);
  if (errors.length > 0) throw new SaberError(`saber.yaml is invalid: ${errors.join("; ")}`, 2);
  const tool = options.tool ?? config.workspace.tools.default;
  if (!(config.workspace.tools.supported ?? [config.workspace.tools.default]).includes(tool)) throw new SaberError(`tool ${tool} is not enabled`, 2);

  let targetRoot = root;
  let projectPath: string | undefined;
  if (options.project !== undefined) {
    const project = config.workspace.projects.find(({ name }) => name === options.project);
    if (project === undefined) throw new SaberError(`unknown project ${options.project}`, 2);
    try {
      targetRoot = await resolveExistingPathWithinRoot(root, project.path);
      if (!(await lstat(targetRoot)).isDirectory()) throw new Error();
      projectPath = project.path;
    } catch { throw new SaberError(`project ${options.project} is missing`, 2); }
  }

  const teamSkills = unique(config.roleProfiles.flatMap(({ teamSkills }) => teamSkills));
  const externalSkills = unique(config.roleProfiles.flatMap(({ externalSkills }) => externalSkills));
  const workflows = unique(config.roleProfiles.flatMap(({ workflows }) => workflows));
  const prompts = unique(config.local?.extensions.prompts ?? []);
  const personalSkills = unique(config.local?.extensions.skills ?? []);
  const capabilities = selectedCapabilities(config, options.project, options.capabilities);
  const sources: Source[] = [];
  for (const id of coreCommands) sources.push({ name: projectionName("core-command", id), kind: "core-command", path: await requireSkillDirectory(root, `skills/${id}`, `core command ${id}`) });
  for (const id of unique([...teamSkills, ...personalSkills]).filter((id) => !coreCommands.includes(id as "saber"))) {
    sources.push({ name: projectionName("team-skill", id), kind: "team-skill", path: await requireSkillDirectory(root, `skills/${id}`, `team skill ${id}`) });
  }
  for (const id of prompts) sources.push({ name: projectionName("personal-prompt", id), kind: "personal-prompt", path: await requireSkillDirectory(root, `prompts/${id}`, `personal prompt ${id}`) });
  for (const id of workflows) sources.push({ name: projectionName("workflow", id), kind: "workflow", path: await requireSkillDirectory(root, `workflows/${id}`, `workflow ${id}`) });
  sources.push(...await externalSources(root, externalSkills));

  const discovery = discoveryDirectories[tool];
  const runtimePath = manifestPath(tool, options.project);
  const previous = await readPrevious(root, runtimePath);
  const adapter = toolConfigAdapters[tool];
  const toolConfigRelative = `${projectPath === undefined ? "" : `${projectPath}/`}${adapter.relativePath}`;
  const toolConfigPath = await managedFilePath(root, toolConfigRelative);
  const oldToolConfig = await readOptional(toolConfigPath);
  const runtimeManifestPath = await managedFilePath(root, runtimePath);
  const oldManifest = await readOptional(runtimeManifestPath);
  const desiredMcp = mcpEntries(config, tool, capabilities);
  const snapshot = adapter.inspect(oldToolConfig);
  if (previous !== undefined) adapter.verify(snapshot, previous.mcpEntries);
  const baseText = previous === undefined || previous.mcpEntries.length === 0
    ? oldToolConfig
    : adapter.remove(snapshot, previous.mcpEntries) ?? undefined;
  const baseSnapshot = adapter.inspect(baseText);
  const finalToolConfig = desiredMcp.length === 0 ? baseText : adapter.render(baseSnapshot, desiredMcp);

  const created: MaterializeProjection[] = [];
  try {
    for (const projection of previous?.projections ?? []) await removeProjection(targetRoot, projection);
    for (const source of sources) created.push(await createProjection(root, targetRoot, discovery, source));
    await writeAtomic(toolConfigPath, finalToolConfig);
    await ensureGitExclude(targetRoot, discovery);
    const teamText = await readOptional(resolveWithinRoot(root, "saber.yaml"));
    const localText = await readOptional(resolveWithinRoot(root, "saber.local.yaml"));
    const externalText = await readOptional(resolveWithinRoot(root, externalManifestPath));
    const manifest: RuntimeManifest = {
      schemaVersion: 4,
      managedBy: "saber",
      tool,
      target: options.project ?? "root",
      project: options.project ?? null,
      capabilities,
      coreCommands: [...coreCommands],
      teamSkills: unique([...teamSkills, ...personalSkills]),
      prompts,
      externalSkills,
      workflows,
      projections: created,
      mcpServers: desiredMcp.map(({ id }) => id.slice("saber--".length)),
      mcpEntries: desiredMcp,
      toolConfig: {
        path: toolConfigRelative,
        existedBefore: previous?.toolConfig.existedBefore ?? (oldToolConfig !== undefined),
        createdBySaber: previous?.toolConfig.createdBySaber ?? (oldToolConfig === undefined && finalToolConfig !== undefined),
        digest: finalToolConfig === undefined ? null : digest(finalToolConfig),
      },
      sourceFingerprints: {
        team: fingerprint(teamText ?? config),
        local: localText === undefined ? null : fingerprint(localText),
        external: externalText === undefined ? null : fingerprint(externalText),
      },
    };
    await writeAtomic(runtimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      ...manifest,
      manifestPath: runtimePath,
      discoveryRoot: projectPath === undefined ? discovery : `${projectPath}/${discovery}`,
    };
  } catch (error: unknown) {
    for (const projection of created.reverse()) await removeProjection(targetRoot, projection).catch(() => undefined);
    if (previous !== undefined) {
      for (const projection of previous.projections) {
        const source = resolveWithinRoot(root, projection.sourcePath);
        const linkPath = await managedLinkPath(targetRoot, projection.linkPath).catch(() => undefined);
        if (linkPath !== undefined) {
          await mkdir(dirname(linkPath), { recursive: true });
          await symlink(projection.linkTarget, linkPath, "dir").catch(() => undefined);
        }
        void source;
      }
    }
    await writeAtomic(toolConfigPath, oldToolConfig).catch(() => undefined);
    await writeAtomic(runtimeManifestPath, oldManifest).catch(() => undefined);
    throw error;
  }
}

export async function materialize(
  root: string,
  config: RepositoryConfig,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  return withRepositoryLifecycleLock(root, () => materializeLocked(root, config, options));
}
