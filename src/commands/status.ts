import { lstat } from "node:fs/promises";

import { parseBooleanArguments } from "../lib/argv.js";
import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import {
  gitCommand,
  runSafeProcess,
  safeVersionLine,
  type SafeProcessRunner,
} from "../lib/git.js";
import { resolveWithinRoot } from "../lib/files.js";
import type { ProjectConfig, RepositoryConfig } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";

export type ProjectWorkspaceState =
  | "missing"
  | "clean"
  | "dirty"
  | "not-a-git-repository";

export type ProjectStatus = {
  name: string;
  path: string;
  state: ProjectWorkspaceState;
  branch?: string;
};

export type WorkspaceStatusReport = {
  valid: boolean;
  errors: string[];
  projects: ProjectStatus[];
};

export type StatusCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type StatusCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
  runner?: SafeProcessRunner;
};

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

function safeErrorMessage(error: unknown): string {
  return error instanceof SaberError ? error.message : "could not read Saber configuration";
}

function fallbackStatus(project: ProjectConfig): ProjectStatus {
  return { name: project.name, path: project.path, state: "not-a-git-repository" };
}

async function inspectProject(
  repositoryRoot: string,
  project: ProjectConfig,
  runner: SafeProcessRunner,
): Promise<ProjectStatus> {
  try {
    const projectPath = resolveWithinRoot(repositoryRoot, project.path);
    let fileStatus;
    try {
      fileStatus = await lstat(projectPath);
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        return { name: project.name, path: project.path, state: "missing" };
      }
      return fallbackStatus(project);
    }
    if (!fileStatus.isDirectory() || fileStatus.isSymbolicLink()) {
      return fallbackStatus(project);
    }

    const repositoryCheck = await runner(
      gitCommand(["rev-parse", "--is-inside-work-tree"], projectPath),
    );
    if (repositoryCheck.exitCode !== 0 || repositoryCheck.stdout?.trim() !== "true") {
      return fallbackStatus(project);
    }

    const branchResult = await runner(gitCommand(["branch", "--show-current"], projectPath));
    const branch = branchResult.exitCode === 0 ? safeVersionLine(branchResult.stdout) : undefined;
    const workingTree = await runner(
      gitCommand(
        ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal"],
        projectPath,
      ),
    );
    if (workingTree.exitCode !== 0 || workingTree.outputTruncated === true) {
      return fallbackStatus(project);
    }

    const result: ProjectStatus = {
      name: project.name,
      path: project.path,
      state: workingTree.stdout?.trim().length === 0 ? "clean" : "dirty",
    };
    if (branch !== undefined) {
      result.branch = branch;
    }
    return result;
  } catch {
    // A single corrupt/missing repository must never prevent inspection of the
    // remaining configured projects.
    return fallbackStatus(project);
  }
}

/** Read each configured project independently with shell-free, bounded Git queries. */
export async function collectWorkspaceStatus(
  repositoryRoot: string,
  dependencies: StatusCommandDependencies = {},
): Promise<WorkspaceStatusReport> {
  const loadConfig = dependencies.loadConfig ?? loadRepositoryConfig;
  const runner = dependencies.runner ?? runSafeProcess;
  let config: RepositoryConfig;
  try {
    config = await loadConfig(repositoryRoot);
  } catch (error: unknown) {
    return { valid: false, errors: [safeErrorMessage(error)], projects: [] };
  }

  const errors = validateRepositoryConfig(config);
  if (errors.length > 0) {
    return { valid: false, errors, projects: [] };
  }

  const projects: ProjectStatus[] = [];
  for (const project of config.workspace.projects) {
    projects.push(await inspectProject(repositoryRoot, project, runner));
  }
  return { valid: true, errors: [], projects };
}

/** Backward-friendly concise entrypoint for callers that need only workspace status. */
export const workspaceStatus = collectWorkspaceStatus;

function formatWorkspaceStatus(report: WorkspaceStatusReport): string {
  if (!report.valid) {
    return `Workspace status unavailable:\n${report.errors.map((error) => `- ${error}`).join("\n")}\n`;
  }

  const lines = ["Workspace status:"];
  for (const project of report.projects) {
    lines.push(
      `- ${project.name} (${project.path}): ${project.state}${project.branch === undefined ? "" : ` [${project.branch}]`}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Run `saber status [--json]`. */
export async function runStatusCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: StatusCommandDependencies },
): Promise<StatusCommandResult> {
  const requestedJson = argv.includes("--json");
  try {
    const parsed = parseBooleanArguments(argv, ["--json"]);
    if (parsed.positionals.length > 0) {
      throw new SaberError("status accepts no positional arguments", 2);
    }
    const report = await collectWorkspaceStatus(cwd, dependencies);
    return {
      exitCode: report.valid ? 0 : 2,
      stdout: parsed.flags.has("--json") ? asJson(report) : formatWorkspaceStatus(report),
      stderr: "",
    };
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      return requestedJson
        ? {
            exitCode: error.exitCode,
            stdout: asJson({ valid: false, errors: [error.message], projects: [] }),
            stderr: "",
          }
        : { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
    }
    return requestedJson
      ? {
          exitCode: 1,
          stdout: asJson({ valid: false, errors: ["status command failed"], projects: [] }),
          stderr: "",
        }
      : { exitCode: 1, stdout: "", stderr: "status command failed\n" };
  }
}
