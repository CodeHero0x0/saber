import { cp, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SaberError } from "./errors.js";

const defaultSkills = [
  "grill-me",
  "grilling",
  "tdd",
  "grill-with-docs",
  "to-spec",
  "to-tickets",
  "implement",
  "domain-modeling",
  "code-review",
];

const defaultConfig = [
  "schemaVersion: 1",
  "",
  "projects: []",
  "# Add a repository, then run saber setup again:",
  "# - name: frontend",
  "#   path: projects/frontend",
  "#   repository: git@github.com:your-org/frontend.git",
  "",
  "skills:",
  "  source: https://github.com/mattpocock/skills",
  "  include:",
  ...defaultSkills.map((id) => `    - ${id}`),
  "",
].join("\n");

const directoryReadmes = new Map<string, string>([
  ["requirements", "# Requirements\n\n只保存跨仓或长期业务需求。\n"],
  ["architecture", "# Architecture\n\n只保存系统边界、跨仓契约和长期架构决策。\n"],
  ["knowledge", "# Knowledge\n\n只保存当前、可复用且有来源证据的事实。\n"],
]);

const rootDirectories = ["requirements", "architecture", "knowledge", "skills", "projects", ".saber"];
const teamSkillIds = ["team-knowledge", "promote"];

export type WorkspaceBootstrapResult = {
  initialized: boolean;
};

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (await exists(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function bundledRoot(explicitRoot: string | undefined): Promise<string> {
  if (explicitRoot !== undefined) return resolve(explicitRoot);
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) throw new SaberError("could not locate bundled Saber assets", 1);
  const entrypointPath = await realpath(entrypoint).catch(() => resolve(entrypoint));
  return resolve(dirname(entrypointPath), "..");
}

async function installTeamSkills(root: string, assetsRoot: string | undefined): Promise<void> {
  const missing = await Promise.all(teamSkillIds.map(async (id) => ({ id, missing: !(await exists(join(root, "skills", id))) })));
  if (!missing.some((skill) => skill.missing)) return;

  const sourceRoot = await bundledRoot(assetsRoot);
  for (const { id, missing: isMissing } of missing) {
    if (!isMissing) continue;
    const source = join(sourceRoot, "skills", id);
    if (!(await exists(join(source, "SKILL.md")))) {
      throw new SaberError(`bundled team skill ${id} is missing`, 1);
    }
    await cp(source, join(root, "skills", id), { recursive: true });
  }
}

/** Create the local team-knowledge workspace required by `saber setup` without replacing member files. */
export async function bootstrapWorkspace(root: string, assetsRoot?: string): Promise<WorkspaceBootstrapResult> {
  const configPath = join(root, "saber.yaml");
  const initialized = !(await exists(configPath));

  await Promise.all(rootDirectories.map((directory) => mkdir(join(root, directory), { recursive: true })));
  await Promise.all([...directoryReadmes].map(([directory, contents]) => writeIfMissing(join(root, directory, "README.md"), contents)));
  await writeIfMissing(join(root, ".gitignore"), "/projects/\n/.saber/\n.DS_Store\n");
  if (initialized) await writeFile(configPath, defaultConfig, "utf8");
  await installTeamSkills(root, assetsRoot);

  return { initialized };
}

/** Keep the shared knowledge layout ready for each configured repository. */
export async function ensureKnowledgeDirectories(root: string, projectNames: readonly string[]): Promise<void> {
  const directories = new Set(["shared", "cross-repo", ...projectNames]);
  await Promise.all([...directories].map((directory) => mkdir(join(root, "knowledge", directory), { recursive: true })));
}
