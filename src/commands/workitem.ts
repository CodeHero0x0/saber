import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import type { RepositoryConfig } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";
import {
  appendWorkitemHandoff,
  compareWorkitemFingerprint,
  createWorkitem,
  getWorkitemStatus,
  type WorkitemRepositoryReference,
  type WorkitemStatusReport,
} from "../lib/workitems.js";

export type WorkitemCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type WorkitemCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
  now?: () => Date;
};

type ParsedOptions = {
  positionals: string[];
  values: ReadonlyMap<string, readonly string[]>;
  flags: ReadonlySet<string>;
};

type CreateRequest = {
  action: "create";
  key: string;
  jiraUrl: string;
  fingerprint: string;
  updatedAt?: string;
  projects: string[];
  json: boolean;
};

type HandoffRequest = {
  action: "handoff";
  key: string;
  role: string;
  summary: string;
  risk: string;
  next: string;
  fingerprint?: string;
  json: boolean;
};

type DriftRequest = {
  action: "drift";
  key: string;
  fingerprint: string;
  json: boolean;
};

type StatusRequest = {
  action: "status";
  key: string;
  json: boolean;
};

type WorkitemRequest = CreateRequest | HandoffRequest | DriftRequest | StatusRequest;

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseOptions(
  argv: readonly string[],
  valueFlags: Readonly<Record<string, { repeatable?: boolean }>>,
): ParsedOptions {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--") {
      throw new SaberError("unexpected argument separator", 2);
    }
    if (argument === "--json") {
      if (flags.has(argument)) {
        throw new SaberError("duplicate flag --json", 2);
      }
      flags.add(argument);
      continue;
    }
    if (argument.startsWith("--")) {
      const specification = valueFlags[argument];
      if (specification === undefined) {
        throw new SaberError("unknown flag", 2);
      }
      const value = argv[index + 1];
      if (value === undefined || value === "--" || value.startsWith("-")) {
        throw new SaberError(`${argument} requires a value`, 2);
      }
      const existing = values.get(argument) ?? [];
      if (!specification.repeatable && existing.length > 0) {
        throw new SaberError(`duplicate flag ${argument}`, 2);
      }
      values.set(argument, [...existing, value]);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new SaberError("unknown flag", 2);
    }
    positionals.push(argument);
  }
  return { positionals, values, flags };
}

function singleValue(options: ParsedOptions, flag: string): string {
  const values = options.values.get(flag);
  if (values === undefined || values.length !== 1 || values[0] === undefined) {
    throw new SaberError(`${flag} is required`, 2);
  }
  return values[0];
}

function oneKey(options: ParsedOptions, command: string): string {
  if (options.positionals.length !== 1 || options.positionals[0] === undefined) {
    throw new SaberError(`workitem ${command} requires exactly one Jira key`, 2);
  }
  return options.positionals[0];
}

function parseWorkitemRequest(argv: readonly string[]): WorkitemRequest {
  const [action, ...rest] = argv;
  if (action === undefined) {
    throw new SaberError("workitem command requires create, handoff, drift, or status", 2);
  }

  if (action === "create") {
    const options = parseOptions(rest, {
      "--jira-url": {},
      "--fingerprint": {},
      "--updated-at": {},
      "--project": { repeatable: true },
    });
    const projects = options.values.get("--project") ?? [];
    if (projects.length === 0) {
      throw new SaberError("workitem create requires at least one --project", 2);
    }
    return {
      action,
      key: oneKey(options, action),
      jiraUrl: singleValue(options, "--jira-url"),
      fingerprint: singleValue(options, "--fingerprint"),
      updatedAt: options.values.get("--updated-at")?.[0],
      projects: [...projects],
      json: options.flags.has("--json"),
    };
  }

  if (action === "handoff") {
    const options = parseOptions(rest, {
      "--role": {},
      "--summary": {},
      "--risk": {},
      "--next": {},
      "--fingerprint": {},
    });
    return {
      action,
      key: oneKey(options, action),
      role: singleValue(options, "--role"),
      summary: singleValue(options, "--summary"),
      risk: singleValue(options, "--risk"),
      next: singleValue(options, "--next"),
      fingerprint: options.values.get("--fingerprint")?.[0],
      json: options.flags.has("--json"),
    };
  }

  if (action === "drift") {
    const options = parseOptions(rest, { "--fingerprint": {} });
    return {
      action,
      key: oneKey(options, action),
      fingerprint: singleValue(options, "--fingerprint"),
      json: options.flags.has("--json"),
    };
  }

  if (action === "status") {
    const options = parseOptions(rest, {});
    return { action, key: oneKey(options, action), json: options.flags.has("--json") };
  }

  throw new SaberError("unknown workitem command", 2);
}

function validateConfig(config: RepositoryConfig): void {
  const errors = validateRepositoryConfig(config);
  if (errors.length > 0) {
    throw new SaberError(`saber.yaml is invalid: ${errors.join("; ")}`, 2);
  }
}

function repositoryReferences(
  config: RepositoryConfig,
  selectedProjects: readonly string[],
): WorkitemRepositoryReference[] {
  const configured = new Map(config.workspace.projects.map((project) => [project.name, project]));
  const seen = new Set<string>();
  const repositories: WorkitemRepositoryReference[] = [];
  for (const projectName of selectedProjects) {
    if (seen.has(projectName)) {
      throw new SaberError(`duplicate workitem project ${projectName}`, 2);
    }
    seen.add(projectName);
    const project = configured.get(projectName);
    if (project === undefined) {
      throw new SaberError(`unknown workspace project ${projectName}`, 2);
    }
    repositories.push(
      project.repository === undefined
        ? { name: project.name, path: project.path }
        : { name: project.name, path: project.path, repository: project.repository },
    );
  }
  return repositories;
}

function formatCreated(
  key: string,
  repositories: readonly WorkitemRepositoryReference[],
): string {
  return `Created workitem ${key} with evidence for: ${repositories.map((repository) => repository.name).join(", ")}.\n`;
}

function formatHandoff(key: string, path: string): string {
  return `Recorded handoff for ${key}: ${path}\n`;
}

function formatDrift(report: Awaited<ReturnType<typeof compareWorkitemFingerprint>>): string {
  if (report.state === "current") {
    return `Workitem ${report.key} source fingerprint is current.\n`;
  }
  return [
    `Workitem ${report.key} is paused because its Jira source fingerprint changed.`,
    `saved fingerprint: ${report.savedFingerprint}`,
    `current fingerprint: ${report.currentFingerprint}`,
    "recovery: review the Jira change with a human, refresh the evidence pack as needed, then rerun drift.",
    "",
  ].join("\n");
}

function formatStatus(report: WorkitemStatusReport): string {
  const lines = [
    `Workitem ${report.key}:`,
    `- Jira: ${report.jiraUrl}`,
    `- Fingerprint: ${report.fingerprint}`,
    `- Jira updated at: ${report.updatedAt ?? "unknown"}`,
    "Artifacts:",
    ...report.artifacts.map(
      (artifact) =>
        `- ${artifact.path}: ${artifact.state}${
          artifact.detail === undefined ? "" : ` (${artifact.detail})`
        }`,
    ),
    "Repositories:",
    ...report.repositories.map(
      (repository) =>
        `- ${repository.name}: ${repository.path}${
          repository.repository === undefined ? "" : ` (${repository.repository})`
        }; branch: ${repository.branch ?? "unknown"}; commit: ${
          repository.commit ?? "unknown"
        }; merge request: ${repository.mergeRequest ?? "unknown"}; CI: ${repository.ci ?? "unknown"}`,
    ),
    `Handoff records: ${report.handoffCount}`,
    "",
  ];
  return lines.join("\n");
}

function requestedJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function errorResult(error: unknown, json: boolean): WorkitemCommandResult {
  const message = error instanceof SaberError ? error.message : "workitem command failed";
  const exitCode = error instanceof SaberError ? error.exitCode : 1;
  return json
    ? { exitCode, stdout: asJson({ valid: false, errors: [message] }), stderr: "" }
    : { exitCode, stdout: "", stderr: `${message}\n` };
}

/** Run strictly parsed L1 local workitem commands. */
export async function runWorkitemCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: WorkitemCommandDependencies },
): Promise<WorkitemCommandResult> {
  const json = requestedJson(argv);
  try {
    const request = parseWorkitemRequest(argv);
    if (request.action === "create") {
      const loadConfig = dependencies.loadConfig ?? loadRepositoryConfig;
      const config = await loadConfig(cwd);
      validateConfig(config);
      const repositories = repositoryReferences(config, request.projects);
      const metadata = await createWorkitem(cwd, {
        key: request.key,
        jiraUrl: request.jiraUrl,
        fingerprint: request.fingerprint,
        updatedAt: request.updatedAt,
        repositories,
      });
      const result = { key: metadata.key, action: "created" as const, repositories: metadata.repositories };
      return {
        exitCode: 0,
        stdout: request.json ? asJson(result) : formatCreated(metadata.key, metadata.repositories),
        stderr: "",
      };
    }

    if (request.action === "handoff") {
      if (request.fingerprint !== undefined) {
        const drift = await compareWorkitemFingerprint(cwd, request.key, request.fingerprint);
        if (drift.state === "paused") {
          return {
            exitCode: 3,
            stdout: request.json ? asJson(drift) : formatDrift(drift),
            stderr: "",
          };
        }
      }
      const handoff = await appendWorkitemHandoff(cwd, {
        key: request.key,
        role: request.role,
        summary: request.summary,
        risk: request.risk,
        next: request.next,
        now: dependencies.now?.(),
      });
      const result = { key: request.key, action: "handoff-recorded" as const, ...handoff };
      return {
        exitCode: 0,
        stdout: request.json ? asJson(result) : formatHandoff(request.key, handoff.path),
        stderr: "",
      };
    }

    if (request.action === "drift") {
      const report = await compareWorkitemFingerprint(cwd, request.key, request.fingerprint);
      return {
        exitCode: report.state === "paused" ? 3 : 0,
        stdout: request.json ? asJson(report) : formatDrift(report),
        stderr: "",
      };
    }

    const report = await getWorkitemStatus(cwd, request.key);
    return {
      exitCode: 0,
      stdout: request.json ? asJson(report) : formatStatus(report),
      stderr: "",
    };
  } catch (error: unknown) {
    return errorResult(error, json);
  }
}
