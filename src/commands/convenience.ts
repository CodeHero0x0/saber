import { COPYFILE_EXCL } from "node:constants";
import { copyFile, lstat } from "node:fs/promises";
import { join } from "node:path";

import { collectDoctorReport } from "./doctor.js";
import { runExternalCommand, type ExternalCommandDependencies } from "./external.js";
import { loadRepositoryConfig } from "../lib/config.js";
import { createDemoWorkitem } from "../lib/demo.js";
import { SaberError } from "../lib/errors.js";
import { materialize, type MaterializeOptions } from "../lib/materialize.js";
import type { RepositoryConfig, RoleName, ToolName } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";
import {
  advanceWorkitem,
  getWorkitemStatus,
  pauseWorkitem,
  resumeWorkitem,
  type WorkitemStatusReport,
} from "../lib/workitems.js";

export type ConvenienceCommandDependencies = {
  loadConfig?: (root: string) => Promise<RepositoryConfig>;
  external?: ExternalCommandDependencies;
  externalUpdate?: typeof runExternalCommand;
  doctor?: typeof collectDoctorReport;
  materialize?: typeof materialize;
  getStatus?: typeof getWorkitemStatus;
  advance?: typeof advanceWorkitem;
  pause?: typeof pauseWorkitem;
  resume?: typeof resumeWorkitem;
  createDemo?: typeof createDemoWorkitem;
  now?: () => Date;
};

export type ConvenienceCommandResult = { exitCode: number; stdout: string; stderr: string };

type Options = {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
};

function parseOptions(
  argv: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = ["--json"],
): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (booleanFlags.includes(argument)) {
      if (flags.has(argument)) throw new SaberError(`duplicate flag ${argument}`, 2);
      flags.add(argument);
    } else if (valueFlags.includes(argument)) {
      if (values.has(argument)) throw new SaberError(`duplicate flag ${argument}`, 2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new SaberError(`${argument} requires a value`, 2);
      values.set(argument, value);
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new SaberError("unknown flag", 2);
    } else {
      positionals.push(argument);
    }
  }
  return { positionals, values, flags };
}

function onePositional(options: Options, label: string): string {
  if (options.positionals.length !== 1) throw new SaberError(`${label} requires exactly one argument`, 2);
  return options.positionals[0]!;
}

function parseRole(value: string): RoleName {
  if (value === "ba" || value === "dev" || value === "qa") return value;
  throw new SaberError("role must be ba, dev, or qa", 2);
}

function parseTool(value: string | undefined): ToolName | undefined {
  if (value === undefined) return undefined;
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new SaberError("tool must be codex, claude, or opencode", 2);
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const toolLabels: Record<ToolName, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

function commonCommands(role: RoleName): string[] {
  if (role === "ba") return [
    "saber open <JIRA-KEY>",
    "saber next <JIRA-KEY> --result ready",
    "saber next <JIRA-KEY> --result accept",
    "saber next <JIRA-KEY> --result reject",
    "saber pause <JIRA-KEY> --reason <text>",
  ];
  if (role === "qa") return [
    "saber open <JIRA-KEY>",
    "saber next <JIRA-KEY> --result pass",
    "saber next <JIRA-KEY> --result fail",
    "saber next <JIRA-KEY> --result blocked",
    "saber loop <JIRA-KEY>",
  ];
  return [
    "saber open <JIRA-KEY>",
    "saber next <JIRA-KEY> --result ready",
    "saber next <JIRA-KEY> --result blocked",
    "saber action preview <capability> --payload <json-file>",
  ];
}

function formatOpen(report: WorkitemStatusReport): string {
  const missing = report.artifacts.filter((artifact) => artifact.state !== "present");
  return [
    `Workitem ${report.key}`,
    `- State: ${report.workflow.state}`,
    `- Role: ${report.workflow.role ?? "none"}`,
    `- Iteration: ${report.workflow.iteration}`,
    `- Jira: ${report.jiraUrl}`,
    `- Fingerprint: ${report.fingerprint}`,
    `- Artifacts: ${report.artifacts.map(({ path, state }) => `${path}=${state}`).join(", ")}`,
    `- Missing evidence: ${missing.length === 0 ? "none" : missing.map(({ path }) => path).join(", ")}`,
    `- Handoffs: ${report.handoffCount}`,
    `- Repositories: ${report.repositories.length === 0 ? "none" : report.repositories.map(({ name, branch, commit, mergeRequest, ci }) => `${name}[branch=${branch ?? "unknown"},commit=${commit ?? "unknown"},mr=${mergeRequest ?? "unknown"},ci=${ci ?? "unknown"}]`).join(", ")}`,
    ...(report.workflow.pauseReason === null ? [] : [`- Paused: ${report.workflow.pauseReason}`]),
    `- Next: ${report.suggestion ?? "complete"}`,
    "",
  ].join("\n");
}

function formatLoop(report: WorkitemStatusReport): string {
  return [
    `Workitem ${report.key} loop (iteration ${report.workflow.iteration}):`,
    "Route: ba-clarify --ready--> dev-build --ready--> qa-verify --pass--> ba-accept --accept--> done",
    "Retry: qa-verify --fail--> dev-fix --ready--> qa-verify; ba-accept --reject--> dev-fix",
    `Current: * ${report.workflow.state}`,
    ...(report.workflow.history.length === 0 ? ["History: none"] : [
      "History:",
      ...report.workflow.history.map((entry) => `- ${entry.from} -> ${entry.to}: ${entry.result} (${entry.role}) - ${entry.summary}`),
    ]),
    `Next: ${report.suggestion ?? "complete"}`,
    "",
  ].join("\n");
}

async function runUse(
  argv: readonly string[],
  cwd: string,
  dependencies: ConvenienceCommandDependencies,
): Promise<ConvenienceCommandResult> {
  const options = parseOptions(argv, ["--tool", "--project"]);
  const role = parseRole(onePositional(options, "use"));
  const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
  const tool = parseTool(options.values.get("--tool")) ?? config.local?.defaults.tool ?? config.workspace.tools.default;
  const project = options.values.get("--project");
  const materializeOptions: MaterializeOptions = {
    role,
    tool,
    ...(project === undefined ? {} : { project }),
  };
  const runtime = await (dependencies.materialize ?? materialize)(cwd, config, materializeOptions);
  const start = `${tool} .`;
  const common = commonCommands(role);
  const result = { role, tool, project: runtime.project, discoveryRoot: runtime.discoveryRoot, start, common };
  return options.flags.has("--json")
    ? { exitCode: 0, stdout: asJson(result), stderr: "" }
    : {
        exitCode: 0,
        stdout: `Role ${role.toUpperCase()} is ready for ${toolLabels[tool]}.\nStart: ${start}\nCommon:\n${common.map((item) => `- ${item}`).join("\n")}\n`,
        stderr: "",
      };
}

async function runSetup(
  argv: readonly string[],
  cwd: string,
  dependencies: ConvenienceCommandDependencies,
): Promise<ConvenienceCommandResult> {
  const options = parseOptions(argv, [], ["--json", "--apply", "--confirm"]);
  if (options.positionals.length > 0) throw new SaberError("setup accepts no positional arguments", 2);
  const apply = options.flags.has("--apply");
  const confirm = options.flags.has("--confirm");
  if (apply !== confirm) throw new SaberError("setup requires --apply and --confirm together", 2);
  const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
  const errors = validateRepositoryConfig(config);
  if (errors.length > 0) throw new SaberError("Saber configuration is invalid", 2);
  const localPath = join(cwd, "saber.local.yaml");
  let localCreated = false;
  try {
    await lstat(localPath);
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
    try {
      await copyFile(join(cwd, "saber.local.example.yaml"), localPath, COPYFILE_EXCL);
      localCreated = true;
    } catch (copyError: unknown) {
      if (!isAlreadyExists(copyError)) throw copyError;
    }
  }
  const doctor = await (dependencies.doctor ?? collectDoctorReport)(cwd, { loadConfig: async () => config });
  const external = await (dependencies.externalUpdate ?? runExternalCommand)(
    ["update", ...(apply ? ["--apply", "--confirm"] : []), "--json"],
    { cwd, dependencies: { ...dependencies.external, loadConfig: async () => config } },
  );
  if (external.exitCode !== 0) return external;
  const result = { valid: true, localCreated, doctor, external: JSON.parse(external.stdout) as unknown };
  return options.flags.has("--json")
    ? { exitCode: 0, stdout: asJson(result), stderr: "" }
    : { exitCode: 0, stdout: `Saber setup ready.\n- Local config: ${localCreated ? "created" : "kept"}\n- External assets: ${apply ? "updated" : "previewed"}\n`, stderr: "" };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

function isEnoent(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

/** Run one top-level daily convenience command. */
export async function runConvenienceCommand(
  command: string,
  argv: readonly string[],
  { cwd, dependencies = {} }: { cwd: string; dependencies?: ConvenienceCommandDependencies },
): Promise<ConvenienceCommandResult> {
  const json = argv.includes("--json");
  try {
    if (command === "setup") return await runSetup(argv, cwd, dependencies);
    if (command === "use") return await runUse(argv, cwd, dependencies);
    if (command === "demo") {
      const options = parseOptions(argv, []);
      if (options.positionals.length > 1) {
        throw new SaberError("demo accepts at most one demo id", 2);
      }
      const result = await (dependencies.createDemo ?? createDemoWorkitem)(cwd, options.positionals[0]);
      return {
        exitCode: 0,
        stdout: options.flags.has("--json")
          ? asJson(result)
          : `Demo ${result.key} created at ${result.path}.\nNext: saber open ${result.key}\n`,
        stderr: "",
      };
    }
    if (command === "open" || command === "loop") {
      const options = parseOptions(argv, []);
      const report = await (dependencies.getStatus ?? getWorkitemStatus)(cwd, onePositional(options, command));
      return { exitCode: 0, stdout: options.flags.has("--json") ? asJson(report) : command === "open" ? formatOpen(report) : formatLoop(report), stderr: "" };
    }
    if (command === "next") {
      const options = parseOptions(argv, ["--result", "--summary", "--risk", "--next", "--fingerprint"]);
      const key = onePositional(options, command);
      const result = options.values.get("--result");
      if (result === undefined) throw new SaberError("--result is required", 2);
      const record = await (dependencies.advance ?? advanceWorkitem)(cwd, {
        key,
        result,
        summary: options.values.get("--summary") ?? `Recorded ${result} for the current stage.`,
        risk: options.values.get("--risk") ?? (result === "blocked" || result === "paused" ? "Human review is required." : "No new risk recorded."),
        next: options.values.get("--next") ?? "The next responsible role reviews the workitem.",
        fingerprint: options.values.get("--fingerprint"),
        now: dependencies.now?.(),
      });
      return { exitCode: record.to === "paused" ? 3 : 0, stdout: options.flags.has("--json") ? asJson(record) : `Workitem ${key}: ${record.from} -> ${record.to} (${record.result}).\n`, stderr: "" };
    }
    if (command === "pause") {
      const options = parseOptions(argv, ["--reason"]);
      const reason = options.values.get("--reason");
      if (reason === undefined) throw new SaberError("--reason is required", 2);
      const record = await (dependencies.pause ?? pauseWorkitem)(cwd, { key: onePositional(options, command), reason, now: dependencies.now?.() });
      return { exitCode: 3, stdout: options.flags.has("--json") ? asJson(record) : `Workitem ${record.key} paused from ${record.from}.\n`, stderr: "" };
    }
    if (command === "resume") {
      const options = parseOptions(argv, ["--fingerprint"]);
      const record = await (dependencies.resume ?? resumeWorkitem)(cwd, { key: onePositional(options, command), fingerprint: options.values.get("--fingerprint"), now: dependencies.now?.() });
      return { exitCode: 0, stdout: options.flags.has("--json") ? asJson(record) : `Workitem ${record.key} resumed at ${record.to}.\n`, stderr: "" };
    }
    throw new SaberError(`Unknown convenience command: ${command}`, 2);
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : `${command} command failed`;
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return json ? { exitCode, stdout: asJson({ valid: false, errors: [message] }), stderr: "" } : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
