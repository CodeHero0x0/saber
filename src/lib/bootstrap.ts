import { cp, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
  "schemaVersion: 2",
  "",
  "projects: []",
  "# Add a repository, then run saber setup again:",
  "# - name: frontend",
  "#   path: projects/frontend",
  "#   repository: git@github.com:your-org/frontend.git",
  "",
  "skills:",
  "  sources:",
  "    - id: mattpocock",
  "      repository: https://github.com/mattpocock/skills",
  "      ref: main",
  "      include:",
  ...defaultSkills.map((id) => `        - ${id}`),
  "    - id: ponytail",
  "      repository: https://github.com/DietrichGebert/ponytail",
  "      ref: v4.8.4",
  "      include:",
  "        - ponytail-review",
  "        - ponytail-audit",
  "        - ponytail-debt",
  "",
  "loop:",
  "  evidenceBranch: origin/main",
  "  maxIterations: 8",
  "  maxNoProgressIterations: 3",
  "  maxMinutes: 60",
  "",
].join("\n");

const directoryReadmes = new Map<string, string>([
  ["requirements", "# Requirements\n\n只保存跨仓或长期业务需求。\n"],
  ["requirements/stories", "# Stories\n\n由 BA 提交并推送的业务需求证据。\n"],
  ["architecture", "# Architecture\n\n只保存系统边界、跨仓契约和长期架构决策。\n"],
  ["architecture/designs", "# Technical Designs\n\n由架构师或 TL 提交并推送的技术设计证据。\n"],
  ["knowledge", "# Knowledge\n\n只保存当前、可复用且有来源证据的事实。\n"],
  ["specs", "# Member Specs\n\n按需求与成员保存经人工确认的实施 Spec、Tickets、决策和结果。\n"],
]);

const rootDirectories = ["requirements/stories", "architecture/designs", "knowledge", "specs", "skills", "projects", ".saber"];
const teamSkillIds = ["team-knowledge", "promote", "loop"];

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
  const sourceRoot = await bundledRoot(assetsRoot);
  for (const id of teamSkillIds) {
    const source = join(sourceRoot, "skills", id);
    if (!(await exists(join(source, "SKILL.md")))) {
      throw new SaberError(`bundled team skill ${id} is missing`, 1);
    }
    const destination = join(root, "skills", id);
    const isManagedRuntime = id === "loop";
    if (!isManagedRuntime && await exists(destination)) continue;
    const sourcePath = await realpath(source);
    const destinationPath = await realpath(destination).catch(() => undefined);
    if (sourcePath === destinationPath) continue;
    if (isManagedRuntime) await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true });
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
