import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { bootstrapWorkspace, ensureKnowledgeDirectories } from "./bootstrap.js";
import { loadSaberConfig } from "./config.js";
import { SaberError } from "./errors.js";
import { syncUpstreamSkills, type UpstreamSkillSynchronizer } from "./remote-skills.js";
import { toolDiscoveryDirectories, type SaberConfig, type ToolName } from "./types.js";

type ManagedLink = { path: string; target: string };
type ProjectManifest = { schemaVersion: 1; links: ManagedLink[] };

export type ProjectSetupReport = {
  name: string;
  status: "installed" | "skipped";
  cloned: boolean;
  reason?: string;
  installed: number;
  removed: number;
  conflicts: string[];
  tools: ToolName[];
};

export type SetupResult = {
  initialized: boolean;
  source: string;
  skills: string[];
  projects: ProjectSetupReport[];
};

export type ProjectCloner = (repository: string, destination: string, root: string) => Promise<void>;

export type SetupDependencies = {
  loadConfig?: (root: string) => Promise<SaberConfig>;
  syncSkills?: UpstreamSkillSynchronizer;
  cloneProject?: ProjectCloner;
  assetsRoot?: string;
};

const teamSkillIds = ["team-knowledge", "promote"] as const;
const manifestRelativePath = ".saber/setup-manifest.json";
const markerStart = "# >>> saber managed paths >>>";
const markerEnd = "# <<< saber managed paths <<<";

function normalize(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !value.split(/[\\/]+/u).includes("..");
}

async function readManifest(projectRoot: string): Promise<ProjectManifest> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(projectRoot, manifestRelativePath), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error();
    const value = raw as Partial<ProjectManifest>;
    if (value.schemaVersion !== 1 || !Array.isArray(value.links)
      || !value.links.every((link) => safeRelativePath(link?.path) && typeof link?.target === "string")) throw new Error();
    return { schemaVersion: 1, links: value.links };
  } catch {
    return { schemaVersion: 1, links: [] };
  }
}

async function existsDirectory(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isDirectory()).catch(() => false);
}

async function existsGitRepository(projectRoot: string): Promise<boolean> {
  return stat(join(projectRoot, ".git")).then(() => true).catch(() => false);
}

async function cloneProjectRepository(repository: string, destination: string, root: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["clone", "--", repository, destination], { cwd: root, stdio: "ignore" });
    child.once("error", () => rejectPromise(new SaberError("could not start git while cloning a configured project", 1)));
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new SaberError("could not clone a configured project repository", 1));
    });
  });
}

async function lstatOptional(path: string) {
  return lstat(path).catch(() => undefined);
}

async function managedLink(
  projectRoot: string,
  relativePath: string,
  sourcePath: string,
  linkType: "file" | "dir",
  previous: ReadonlyMap<string, string>,
): Promise<{ link?: ManagedLink; conflict?: string }> {
  const linkPath = join(projectRoot, relativePath);
  const target = relative(dirname(linkPath), sourcePath) || ".";
  const status = await lstatOptional(linkPath);
  if (status === undefined) {
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(target, linkPath, linkType);
    return { link: { path: normalize(relativePath), target } };
  }
  if (!status.isSymbolicLink()) return { conflict: normalize(relativePath) };

  const actualTarget = await readlink(linkPath);
  const knownManaged = previous.get(normalize(relativePath)) === actualTarget;
  if (!knownManaged) return { conflict: normalize(relativePath) };

  if (actualTarget !== target) {
    await unlink(linkPath);
    await symlink(target, linkPath, linkType);
  }
  return { link: { path: normalize(relativePath), target } };
}

async function removeStaleLinks(
  projectRoot: string,
  previous: readonly ManagedLink[],
  wanted: ReadonlySet<string>,
): Promise<number> {
  let removed = 0;
  for (const link of previous) {
    if (wanted.has(link.path)) continue;
    const path = join(projectRoot, link.path);
    const status = await lstatOptional(path);
    if (status === undefined || !status.isSymbolicLink()) continue;
    if (await readlink(path) !== link.target) continue;
    await unlink(path);
    removed += 1;
  }
  return removed;
}

async function gitDirectory(projectRoot: string): Promise<string | undefined> {
  const path = join(projectRoot, ".git");
  const status = await stat(path).catch(() => undefined);
  if (status?.isDirectory()) return path;
  if (!status?.isFile()) return undefined;
  const text = await readFile(path, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+)\s*$/mu.exec(text);
  return match === null ? undefined : resolve(projectRoot, match[1]!);
}

async function writeManagedExcludes(projectRoot: string, paths: readonly string[]): Promise<void> {
  const directory = await gitDirectory(projectRoot);
  if (directory === undefined) return;
  const path = join(directory, "info", "exclude");
  const current = await readFile(path, "utf8").catch(() => "");
  const start = current.indexOf(markerStart);
  const end = start < 0 ? -1 : current.indexOf(markerEnd, start);
  const withoutManaged = start < 0 || end < 0
    ? current.trimEnd()
    : [current.slice(0, start).trimEnd(), current.slice(end + markerEnd.length).trim()]
      .filter((section) => section.length > 0)
      .join("\n");
  const entries = [...new Set(paths.map((entry) => `/${entry}`))].sort();
  const block = `${markerStart}\n${entries.join("\n")}\n${markerEnd}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${withoutManaged.length === 0 ? "" : `${withoutManaged}\n`}${block}\n`, "utf8");
}

async function assertTeamSkill(root: string, id: string): Promise<string> {
  const path = join(root, "skills", id);
  if (!(await existsDirectory(path)) || !(await stat(join(path, "SKILL.md")).then((value) => value.isFile()).catch(() => false))) {
    throw new SaberError(`Saber team skill ${id} is missing`, 1);
  }
  return path;
}

async function setupProject(
  root: string,
  config: SaberConfig,
  cacheDirectory: string,
  project: SaberConfig["projects"][number],
  cloneProject: ProjectCloner,
): Promise<ProjectSetupReport> {
  const projectRoot = join(root, project.path);
  let cloned = false;
  if (!(await existsDirectory(projectRoot))) {
    if (project.repository === undefined) {
      return { name: project.name, status: "skipped", cloned, reason: "project directory is absent", installed: 0, removed: 0, conflicts: [], tools: [] };
    }
    await cloneProject(project.repository, projectRoot, root);
    cloned = true;
  }
  if (!(await existsGitRepository(projectRoot))) {
    return { name: project.name, status: "skipped", cloned, reason: "project directory is not a Git repository", installed: 0, removed: 0, conflicts: [], tools: [] };
  }

  const previous = await readManifest(projectRoot);
  const previousTargets = new Map(previous.links.map((link) => [link.path, link.target]));
  const sources = new Map<string, string>();
  for (const id of config.skills.include) sources.set(id, join(cacheDirectory, id));
  for (const id of teamSkillIds) sources.set(id, await assertTeamSkill(root, id));
  for (const [id, source] of sources) {
    if (!(await existsDirectory(source))) throw new SaberError(`managed skill source ${id} is missing`, 1);
  }

  const tools: ToolName[] = [];
  const desiredPaths = new Set<string>();
  for (const [tool, discovery] of Object.entries(toolDiscoveryDirectories) as Array<[ToolName, string]>) {
    await mkdir(join(projectRoot, discovery), { recursive: true });
    tools.push(tool);
    for (const id of sources.keys()) desiredPaths.add(normalize(join(discovery, id)));
  }
  desiredPaths.add("CONTEXT.md");
  desiredPaths.add("docs/adr");

  const removed = await removeStaleLinks(projectRoot, previous.links, desiredPaths);
  const links: ManagedLink[] = [];
  const conflicts: string[] = [];

  for (const [tool, discovery] of Object.entries(toolDiscoveryDirectories) as Array<[ToolName, string]>) {
    if (!tools.includes(tool)) continue;
    for (const [id, source] of sources) {
      const result = await managedLink(projectRoot, join(discovery, id), source, "dir", previousTargets);
      if (result.link !== undefined) links.push(result.link);
      if (result.conflict !== undefined) conflicts.push(result.conflict);
    }
  }

  const domainRoot = join(projectRoot, ".saber", "work", "domain");
  await mkdir(join(projectRoot, ".saber", "work", "features"), { recursive: true });
  await mkdir(join(domainRoot, "adr"), { recursive: true });
  const context = await managedLink(projectRoot, "CONTEXT.md", join(domainRoot, "CONTEXT.md"), "file", previousTargets);
  const adr = await managedLink(projectRoot, "docs/adr", join(domainRoot, "adr"), "dir", previousTargets);
  if (context.link !== undefined) links.push(context.link);
  if (adr.link !== undefined) links.push(adr.link);
  if (context.conflict !== undefined) conflicts.push(context.conflict);
  if (adr.conflict !== undefined) conflicts.push(adr.conflict);

  await mkdir(join(projectRoot, ".saber"), { recursive: true });
  await writeFile(join(projectRoot, manifestRelativePath), `${JSON.stringify({ schemaVersion: 1, links }, null, 2)}\n`, "utf8");
  await writeManagedExcludes(projectRoot, [
    ".saber/setup-manifest.json",
    ".saber/work/",
    ...links.map((link) => link.path),
  ]);

  return { name: project.name, status: "installed", cloned, installed: links.length, removed, conflicts, tools };
}

/** Install the selected team capability set from a Saber root into its nested business repositories. */
export async function setupWorkspace(root: string, dependencies: SetupDependencies = {}): Promise<SetupResult> {
  const bootstrap = await bootstrapWorkspace(root, dependencies.assetsRoot);
  const config = await (dependencies.loadConfig ?? loadSaberConfig)(root);
  await ensureKnowledgeDirectories(root, config.projects.map((project) => project.name));
  const sync = dependencies.syncSkills ?? syncUpstreamSkills;
  const synced = await sync(root, config.skills.source, config.skills.include);
  const cloneProject = dependencies.cloneProject ?? cloneProjectRepository;
  const projects = await Promise.all(config.projects.map((project) => setupProject(root, config, synced.cacheDirectory, project, cloneProject)));
  return { initialized: bootstrap.initialized, source: config.skills.source, skills: [...config.skills.include, ...teamSkillIds], projects };
}
