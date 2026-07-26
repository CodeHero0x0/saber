import { readFile } from "node:fs/promises";

import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import { resolveExistingPathWithinRoot } from "../lib/files.js";
import {
  createWorkitem,
  getWorkitemStatus,
  type WorkitemRepositoryReference,
} from "../lib/workitems.js";

export type WorkitemCommandResult = { exitCode: number; stdout: string; stderr: string };
export type WorkitemCommandDependencies = {
  loadConfig?: typeof loadRepositoryConfig;
  now?: () => Date;
};

type Options = { positionals: string[]; values: Map<string, string[]>; flags: Set<string> };

function asJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

function parseOptions(argv: readonly string[], valueFlags: readonly string[]): Options {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (flags.has(argument)) throw new SaberError("duplicate flag --json", 2); flags.add(argument); continue; }
    if (argument?.startsWith("--")) {
      if (!valueFlags.includes(argument)) throw new SaberError("unknown flag", 2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new SaberError(`${argument} requires a value`, 2);
      values.set(argument, [...(values.get(argument) ?? []), value]);
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) throw new SaberError("unknown flag", 2);
    if (argument !== undefined) positionals.push(argument);
  }
  return { positionals, values, flags };
}

function required(options: Options, flag: string): string {
  const values = options.values.get(flag);
  if (values?.length !== 1) throw new SaberError(`${flag} is required`, 2);
  return values[0]!;
}

function one(options: Options, label: string): string {
  if (options.positionals.length !== 1) throw new SaberError(`${label} requires exactly one workitem name`, 2);
  return options.positionals[0]!;
}

type Request =
  | { action: "create"; name?: string; sourceType: string; sourceTitle: string; sourceFile: string; sourceOrigin?: string; capturedAt?: string; references: string[]; projects: string[]; json: boolean }
  | { action: "status"; name: string; json: boolean };

function parseRequest(argv: readonly string[]): Request {
  const action = argv[0];
  if (action !== "create" && action !== "status") throw new SaberError("workitem requires create or status", 2);
  const options = parseOptions(argv.slice(1), action === "create"
    ? ["--source-type", "--source-title", "--source-file", "--source-origin", "--captured-at", "--source-reference", "--project"]
    : []);
  if (action === "status") return { action, name: one(options, "workitem status"), json: options.flags.has("--json") };
  if (options.positionals.length > 1) throw new SaberError("workitem create accepts at most one name", 2);
  return {
    action,
    name: options.positionals[0],
    sourceType: required(options, "--source-type"),
    sourceTitle: required(options, "--source-title"),
    sourceFile: required(options, "--source-file"),
    sourceOrigin: options.values.get("--source-origin")?.[0],
    capturedAt: options.values.get("--captured-at")?.[0],
    references: options.values.get("--source-reference") ?? [],
    projects: options.values.get("--project") ?? [],
    json: options.flags.has("--json"),
  };
}

/** Internal helper for the /saber skill. Members use natural language, not this command. */
export async function runWorkitemCommand(
  argv: readonly string[],
  { cwd, dependencies = {} }: { cwd: string; dependencies?: WorkitemCommandDependencies },
): Promise<WorkitemCommandResult> {
  const jsonRequested = argv.includes("--json");
  try {
    const request = parseRequest(argv);
    if (request.action === "status") {
      const report = await getWorkitemStatus(cwd, request.name);
      return { exitCode: report.state === "valid" ? 0 : 2, stdout: request.json ? asJson(report) : `${report.path}: ${report.state}\n${[...report.errors, ...report.risks].map((message) => `- ${message}`).join("\n")}\n`, stderr: "" };
    }
    const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
    const repositories: WorkitemRepositoryReference[] = request.projects.map((name) => {
      const project = config.workspace.projects.find((candidate) => candidate.name === name);
      if (project === undefined) throw new SaberError(`unknown project ${name}`, 2);
      return { id: project.name, path: project.path, ...(project.repository === undefined ? {} : { repository: project.repository }) };
    });
    const content = await readFile(await resolveSourceFile(cwd, request.sourceFile), "utf8");
    const workitem = await createWorkitem(cwd, {
      key: request.name,
      source: {
        kind: request.sourceType,
        title: request.sourceTitle,
        content,
        ...(request.sourceOrigin === undefined ? {} : { origin: request.sourceOrigin }),
        ...(request.capturedAt === undefined ? {} : { capturedAt: request.capturedAt }),
        references: request.references,
      },
      repositories,
      now: dependencies.now?.(),
    });
    return { exitCode: 0, stdout: request.json ? asJson({ ok: true, workitem }) : `Created ${workitem.path}\n`, stderr: "" };
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : "workitem command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return jsonRequested ? { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" } : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}

async function resolveSourceFile(cwd: string, path: string): Promise<string> {
  if (path.length === 0 || path.startsWith("/") || path.split(/[\\/]/u).includes("..")) {
    throw new SaberError("source file must be inside the Saber repository", 2);
  }
  try {
    return await resolveExistingPathWithinRoot(cwd, path);
  } catch {
    throw new SaberError("source file must be inside the Saber repository", 2);
  }
}
