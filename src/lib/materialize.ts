import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { SaberError } from "./errors.js";
import { resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import type {
  ExternalAssetsConfig,
  RepositoryConfig,
  RoleName,
  RoleProfile,
  ToolName,
} from "./models.js";
import { validateRepositoryConfig } from "./validation.js";

type ProjectionKind = "context" | "team-skill" | "workflow" | "external-skill";

type ExternalManifestEntry = {
  id: string;
  category: "skill-collection" | "mcp-server";
  materializedPath: string;
  revision: string | null;
};

type Projection = {
  name: string;
  kind: ProjectionKind;
  linkPath: string;
  sourcePath: string;
};

type RuntimeManifest = {
  schemaVersion: 1;
  managedBy: "saber";
  tool: ToolName;
  role: RoleName;
  project: string | null;
  capabilities: string[];
  teamSkills: string[];
  externalSkills: string[];
  workflows: string[];
  projections: Projection[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRuntimeManifest(value: unknown): value is RuntimeManifest {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.managedBy === "saber" &&
    (value.tool === "codex" || value.tool === "claude" || value.tool === "opencode") &&
    (value.role === "ba" || value.role === "dev" || value.role === "qa") &&
    (typeof value.project === "string" || value.project === null) &&
    isStringArray(value.capabilities) &&
    isStringArray(value.teamSkills) &&
    isStringArray(value.externalSkills) &&
    isStringArray(value.workflows) &&
    Array.isArray(value.projections) &&
    value.projections.every(
      (projection) =>
        isRecord(projection) &&
        typeof projection.name === "string" &&
        (projection.kind === "context" ||
          projection.kind === "team-skill" ||
          projection.kind === "workflow" ||
          projection.kind === "external-skill") &&
        typeof projection.linkPath === "string" &&
        typeof projection.sourcePath === "string",
    )
  );
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
  const profile = (config.roleProfiles ?? []).find((candidate) => candidate.id === role);
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
): Promise<string> {
  try {
    const directory = await resolveExistingPathWithinRoot(repositoryRoot, relativePath);
    const status = await lstat(directory);
    const entrypoint = await resolveExistingPathWithinRoot(
      repositoryRoot,
      `${relativePath}/SKILL.md`,
    );
    if (!status.isDirectory() || status.isSymbolicLink() || !(await lstat(entrypoint)).isFile()) {
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

function projectionName(kind: ProjectionKind, id: string): string {
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
    const value = JSON.parse(
      await readFile(await resolveExistingPathWithinRoot(repositoryRoot, relativePath), "utf8"),
    ) as unknown;
    if (!isRuntimeManifest(value)) {
      throw new SaberError("materialize runtime manifest is not managed by Saber", 2);
    }
    return value;
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
  projection: Projection,
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
  projection: Projection,
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
  projection: Projection,
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
): Promise<Projection> {
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
  return {
    name,
    kind: name.includes("--context--") ? "context" : name.includes("--workflow--") ? "workflow" : name.includes("--external-skill--") ? "external-skill" : "team-skill",
    linkPath: `${discoveryRelativePath}/${name}`,
    sourcePath: source,
  };
}

function contextSkillContent(
  profile: RoleProfile,
  capabilities: readonly string[],
  project: string | undefined,
): string {
  return `---\nname: saber-context-${profile.id}\ndescription: Use at the start of Saber work as the active ${profile.id.toUpperCase()} role context.\n---\n\n# Saber ${profile.id.toUpperCase()} context\n\n- Role: ${profile.id}\n- Project: ${project ?? "cross-repository workspace"}\n- Capabilities: ${capabilities.join(", ")}\n- Team skills: ${profile.teamSkills.join(", ")}\n- External skills: ${profile.externalSkills.join(", ")}\n- Workflows: ${profile.workflows.join(", ")}\n\nTreat the role as context and human responsibility, not authorization. L2 actions require an exact preview and human confirmation; L3 actions are forbidden. Read the linked role, workflow, and skill packages as needed.\n`;
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
  const path = resolveWithinRoot(repositoryRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

/** Materialize only one role's approved assets into a tool-native discovery directory. */
export async function materialize(
  repositoryRoot: string,
  config: RepositoryConfig,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
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

  const capabilities = selectedCapabilities(
    config,
    profile,
    options.capabilities,
    options.project,
  );
  const teamSources = await Promise.all(
    profile.teamSkills.map(async (id) => ({
      id,
      source: await requireDirectoryWithSkill(repositoryRoot, `skills/${id}`, `team skill ${id}`),
    })),
  );
  const workflowSources = await Promise.all(
    profile.workflows.map(async (id) => ({
      id,
      source: await requireDirectoryWithSkill(repositoryRoot, `workflows/${id}`, `workflow ${id}`),
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
    (previous.tool !== tool || previous.project !== (options.project ?? null))
  ) {
    throw new SaberError("materialize runtime manifest does not match its managed target", 2);
  }

  await ensureLocalGitExclude(targetRoot, discoveryRelativePath);
  const contextSource = await writeContextPackage(
    repositoryRoot,
    tool,
    options.project,
    profile,
    capabilities,
  );
  const sources: Array<{ name: string; source: string }> = [
    { name: projectionName("context", profile.id), source: contextSource },
    ...teamSources.map((asset) => ({
      name: projectionName("team-skill", asset.id),
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
      if (backup !== undefined) {
        backups.push(backup);
      }
    }
  }
  await preflightProjectionDestinations(
    targetRoot,
    discoveryRelativePath,
    sources.map(({ name }) => name),
    new Set(backups.map(({ path }) => path)),
  );

  const projections: Projection[] = [];
  try {
    for (const projection of previous?.projections ?? []) {
      await removeManagedProjection(targetRoot, discoveryRelativePath, projection);
    }
    for (const source of sources) {
      projections.push(
        await createProjection(targetRoot, discoveryRelativePath, source.name, source.source),
      );
    }

    const manifest: RuntimeManifest = {
      schemaVersion: 1,
      managedBy: "saber",
      tool,
      role: profile.id,
      project: options.project ?? null,
      capabilities,
      teamSkills: [...profile.teamSkills],
      externalSkills: [...profile.externalSkills],
      workflows: [...profile.workflows],
      projections: projections.map((projection) => ({
        ...projection,
        sourcePath: relative(repositoryRoot, projection.sourcePath).replaceAll(sep, "/"),
      })),
    };
    await writeRuntimeManifest(repositoryRoot, manifestRelativePath, manifest);
    return {
      ...manifest,
      manifestPath: manifestRelativePath,
      discoveryRoot:
        projectRelativePath === undefined
          ? discoveryRelativePath
          : `${projectRelativePath.replaceAll("\\", "/")}/${discoveryRelativePath}`,
    };
  } catch (error: unknown) {
    for (const projection of projections.reverse()) {
      try {
        await removeManagedProjection(targetRoot, discoveryRelativePath, projection);
      } catch {
        // Keep attempting the remaining cleanup before reporting the failure.
      }
    }
    try {
      await restoreProjectionBackups(backups);
    } catch {
      throw new SaberError("materialize failed and could not restore the previous projections", 3);
    }
    throw error;
  }
}
