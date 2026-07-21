import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseBooleanArguments } from "../lib/argv.js";
import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import { resolveWithinRoot } from "../lib/files.js";
import { gitCloneCommand, runSafeProcess, type SafeProcessRunner } from "../lib/git.js";
import type { ProjectConfig, RepositoryConfig } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";

export type InitProjectOperation = {
  name: string;
  path: string;
  state: "missing" | "existing" | "no-source";
  action: "clone" | "skip";
  repository?: string;
};

export type InitReport = {
  mode: "dry-run" | "applied";
  valid: boolean;
  errors: string[];
  projects: InitProjectOperation[];
};

export type InitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type InitCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
  runner?: SafeProcessRunner;
};

type InitRequest = {
  apply: boolean;
  json: boolean;
};

type PlannedProjectOperation = {
  operation: InitProjectOperation;
  destination: string;
  source?: string;
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

function parseInitRequest(argv: readonly string[]): InitRequest {
  const parsed = parseBooleanArguments(argv, ["--apply", "--confirm", "--json"]);
  if (parsed.positionals.length > 0) {
    throw new SaberError("init accepts no positional arguments", 2);
  }

  const apply = parsed.flags.has("--apply");
  const confirm = parsed.flags.has("--confirm");
  if (apply && !confirm) {
    throw new SaberError("--apply requires --confirm", 2);
  }
  if (confirm && !apply) {
    throw new SaberError("--confirm requires --apply", 2);
  }

  return { apply, json: parsed.flags.has("--json") };
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * A lexical root check alone is not enough for a write. Refuse every existing
 * symlink component, including a link that still happens to point inside root.
 */
async function assertNoSymbolicLinkComponents(
  repositoryRoot: string,
  project: ProjectConfig,
): Promise<void> {
  let currentPath = resolve(repositoryRoot);
  for (const segment of project.path.split(/[\\/]+/u)) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new SaberError(`project ${project.name} has an unsafe path`, 2);
    }
    currentPath = join(currentPath, segment);
    const status = await lstatIfPresent(currentPath);
    if (status?.isSymbolicLink()) {
      throw new SaberError(
        `project ${project.name} destination contains a symbolic link`,
        2,
      );
    }
    if (status === undefined) {
      // Descendants cannot exist after the first absent component.
      return;
    }
  }
}

async function planProjectInitialization(
  repositoryRoot: string,
  project: ProjectConfig,
): Promise<PlannedProjectOperation> {
  await assertNoSymbolicLinkComponents(repositoryRoot, project);
  const destination = resolveWithinRoot(repositoryRoot, project.path);
  const status = await lstatIfPresent(destination);
  if (status !== undefined) {
    return {
      destination,
      operation: {
        name: project.name,
        path: project.path,
        state: "existing",
        action: "skip",
        ...(project.repository === undefined ? {} : { repository: project.repository }),
      },
    };
  }
  if (project.repository === undefined) {
    return {
      destination,
      operation: { name: project.name, path: project.path, state: "no-source", action: "skip" },
    };
  }
  return {
    destination,
    source: project.repository,
    operation: {
      name: project.name,
      path: project.path,
      state: "missing",
      action: "clone",
      repository: project.repository,
    },
  };
}

/** Create a non-mutating initialization plan using only repository-bounded paths. */
export async function planWorkspaceInitialization(
  repositoryRoot: string,
  config: RepositoryConfig,
): Promise<PlannedProjectOperation[]> {
  const operations: PlannedProjectOperation[] = [];
  for (const project of config.workspace.projects) {
    operations.push(await planProjectInitialization(repositoryRoot, project));
  }
  return operations;
}

async function applyWorkspaceInitialization(
  repositoryRoot: string,
  config: RepositoryConfig,
  runner: SafeProcessRunner,
): Promise<InitProjectOperation[]> {
  const operations = await planWorkspaceInitialization(repositoryRoot, config);
  for (const planned of operations) {
    if (planned.operation.action !== "clone" || planned.source === undefined) {
      continue;
    }

    const project = config.workspace.projects.find(
      (candidate) => candidate.name === planned.operation.name,
    );
    if (project === undefined) {
      throw new SaberError("initialization plan no longer matches configuration", 1);
    }

    // Re-check immediately before and after parent creation. An existing path
    // always wins over cloning; Saber never deletes or reclones it.
    await assertNoSymbolicLinkComponents(repositoryRoot, project);
    if ((await lstatIfPresent(planned.destination)) !== undefined) {
      continue;
    }
    await mkdir(dirname(planned.destination), { recursive: true });
    await assertNoSymbolicLinkComponents(repositoryRoot, project);
    if ((await lstatIfPresent(planned.destination)) !== undefined) {
      continue;
    }

    const result = await runner(gitCloneCommand(planned.source, planned.destination));
    if (result.exitCode !== 0) {
      throw new SaberError(`could not clone project ${planned.operation.name}`, 1);
    }
  }
  return operations.map((planned) => planned.operation);
}

function formatInitReport(report: InitReport): string {
  if (!report.valid) {
    return `Workspace initialization unavailable:\n${report.errors.map((error) => `- ${error}`).join("\n")}\n`;
  }

  const title = report.mode === "dry-run" ? "DRY RUN" : "APPLIED";
  const lines = [`Workspace initialization (${title}):`];
  for (const project of report.projects) {
    if (project.action === "clone") {
      lines.push(`- ${project.name}: clone ${project.path}`);
    } else if (project.state === "no-source") {
      lines.push(`- ${project.name}: skip ${project.path} (no repository source)`);
    } else {
      lines.push(`- ${project.name}: skip ${project.path} (already exists)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Run `saber init [--apply --confirm] [--json]`. */
export async function runInitCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: InitCommandDependencies },
): Promise<InitCommandResult> {
  const requestedJson = argv.includes("--json");
  try {
    const request = parseInitRequest(argv);
    const loadConfig = dependencies.loadConfig ?? loadRepositoryConfig;
    let config: RepositoryConfig;
    try {
      config = await loadConfig(cwd);
    } catch (error: unknown) {
      const report: InitReport = {
        mode: request.apply ? "applied" : "dry-run",
        valid: false,
        errors: [safeErrorMessage(error)],
        projects: [],
      };
      return {
        exitCode: 2,
        stdout: request.json ? asJson(report) : formatInitReport(report),
        stderr: "",
      };
    }

    const validationErrors = validateRepositoryConfig(config);
    if (validationErrors.length > 0) {
      const report: InitReport = {
        mode: request.apply ? "applied" : "dry-run",
        valid: false,
        errors: validationErrors,
        projects: [],
      };
      return {
        exitCode: 2,
        stdout: request.json ? asJson(report) : formatInitReport(report),
        stderr: "",
      };
    }

    const planned = await planWorkspaceInitialization(cwd, config);
    const projects = request.apply
      ? await applyWorkspaceInitialization(cwd, config, dependencies.runner ?? runSafeProcess)
      : planned.map((operation) => operation.operation);
    const report: InitReport = {
      mode: request.apply ? "applied" : "dry-run",
      valid: true,
      errors: [],
      projects,
    };
    return {
      exitCode: 0,
      stdout: request.json ? asJson(report) : formatInitReport(report),
      stderr: "",
    };
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      return requestedJson
        ? {
            exitCode: error.exitCode,
            stdout: asJson({
              mode: argv.includes("--apply") ? "applied" : "dry-run",
              valid: false,
              errors: [error.message],
              projects: [],
            }),
            stderr: "",
          }
        : { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
    }
    return requestedJson
      ? {
          exitCode: 1,
          stdout: asJson({
            mode: argv.includes("--apply") ? "applied" : "dry-run",
            valid: false,
            errors: ["init command failed"],
            projects: [],
          }),
          stderr: "",
        }
      : { exitCode: 1, stdout: "", stderr: "init command failed\n" };
  }
}
