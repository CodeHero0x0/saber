import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import { resolveWithinRoot } from "../lib/files.js";
import type { RepositoryConfig } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";
import {
  advanceWorkitem,
  compareWorkitemFingerprint,
  createWorkitem,
  getWorkitemStatus,
  pauseWorkitem,
  resumeWorkitem,
  type WorkitemRepositoryReference,
  type WorkitemStatusReport,
} from "../lib/workitems.js";

export type WorkitemCommandResult = { exitCode: number; stdout: string; stderr: string };
export type WorkitemCommandDependencies = { loadConfig?: (root: string) => Promise<RepositoryConfig>; now?: () => Date };

type Options = { positionals: string[]; values: Map<string, string[]>; flags: Set<string> };

function asJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

function parseOptions(argv: readonly string[], valueFlags: Record<string, boolean> = {}): Options {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (flags.has(argument)) throw new SaberError("duplicate flag --json", 2); flags.add(argument); continue; }
    if (argument?.startsWith("--")) {
      if (!Object.hasOwn(valueFlags, argument)) throw new SaberError("unknown flag", 2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new SaberError(`${argument} requires a value`, 2);
      const existing = values.get(argument) ?? [];
      if (!valueFlags[argument] && existing.length > 0) throw new SaberError(`duplicate flag ${argument}`, 2);
      values.set(argument, [...existing, value]); index += 1; continue;
    }
    if (argument?.startsWith("-")) throw new SaberError("unknown flag", 2);
    if (argument !== undefined) positionals.push(argument);
  }
  return { positionals, values, flags };
}

function one(options: Options, label: string): string {
  if (options.positionals.length !== 1) throw new SaberError(`${label} requires exactly one workitem key`, 2);
  return options.positionals[0]!;
}
function required(options: Options, flag: string): string {
  const values = options.values.get(flag);
  if (values === undefined || values.length !== 1) throw new SaberError(`${flag} is required`, 2);
  return values[0]!;
}
function configValid(config: RepositoryConfig): void {
  const errors = validateRepositoryConfig(config);
  if (errors.length > 0) throw new SaberError(`saber.yaml is invalid: ${errors.join("; ")}`, 2);
}

function formatStatus(report: WorkitemStatusReport): string {
  const missing = report.artifacts.filter(({ state }) => state !== "present");
  return [
    `Workitem ${report.key}`,
    `- State: ${report.workflow.state}`,
    `- Source: ${report.source.kind} - ${report.source.title}`,
    `- Fingerprint: ${report.fingerprint}`,
    `- Artifacts: ${report.artifacts.map(({ path, state }) => `${path}=${state}`).join(", ")}`,
    `- Missing evidence: ${missing.length === 0 ? "none" : missing.map(({ path }) => path).join(", ")}`,
    `- Repositories: ${report.repositories.length === 0 ? "none" : report.repositories.map(({ name, branch, commit }) => `${name}[${branch ?? "unknown"},${commit ?? "unknown"}]`).join(", ")}`,
    `- Next: ${report.suggestion ?? "complete"}`,
    "",
  ].join("\n");
}

type Request =
  | { action: "create"; key?: string; sourceType: string; sourceTitle: string; sourceFile: string; sourceOrigin?: string; capturedAt?: string; references: string[]; projects: string[]; json: boolean }
  | { action: "status" | "drift" | "pause" | "resume" | "advance"; key: string; fingerprint?: string; result?: string; summary?: string; risk?: string; next?: string; reason?: string; json: boolean };

function parseRequest(argv: readonly string[]): Request {
  const action = argv[0];
  if (action === undefined) throw new SaberError("workitem requires create, status, drift, advance, pause, or resume", 2);
  const options = parseOptions(argv.slice(1), {
    "--source-type": false, "--source-title": false, "--source-file": false, "--source-origin": false,
    "--captured-at": false, "--source-reference": true, "--project": true, "--fingerprint": false,
    "--result": false, "--summary": false, "--risk": false, "--next": false, "--reason": false,
  });
  if (action === "create") {
    if (options.positionals.length > 1) throw new SaberError("workitem create accepts at most one key", 2);
    const projects = options.values.get("--project") ?? [];
    if (projects.length === 0) throw new SaberError("workitem create requires --project", 2);
    return {
      action, key: options.positionals[0], sourceType: required(options, "--source-type"), sourceTitle: required(options, "--source-title"), sourceFile: required(options, "--source-file"),
      sourceOrigin: options.values.get("--source-origin")?.[0], capturedAt: options.values.get("--captured-at")?.[0], references: options.values.get("--source-reference") ?? [], projects, json: options.flags.has("--json"),
    };
  }
  const key = one(options, `workitem ${action}`);
  return {
    action: action as Request["action"], key, fingerprint: options.values.get("--fingerprint")?.[0], result: options.values.get("--result")?.[0],
    summary: options.values.get("--summary")?.[0], risk: options.values.get("--risk")?.[0], next: options.values.get("--next")?.[0], reason: options.values.get("--reason")?.[0], json: options.flags.has("--json"),
  } as Request;
}

export async function runWorkitemCommand(argv: readonly string[], { cwd, dependencies = {} }: { cwd: string; dependencies?: WorkitemCommandDependencies }): Promise<WorkitemCommandResult> {
  const jsonRequested = argv.includes("--json");
  try {
    const request = parseRequest(argv);
    if (request.action === "create") {
      const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
      configValid(config);
      const content = await readFile(resolveWithinRoot(cwd, request.sourceFile), "utf8");
      const repositories: WorkitemRepositoryReference[] = request.projects.map((name) => {
        const project = config.workspace.projects.find(({ name: candidate }) => candidate === name);
        if (project === undefined) throw new SaberError(`unknown project ${name}`, 2);
        return { name: project.name, path: project.path, ...(project.repository === undefined ? {} : { repository: project.repository }) };
      });
      const metadata = await createWorkitem(cwd, { key: request.key, source: { kind: request.sourceType, title: request.sourceTitle, content, ...(request.sourceOrigin === undefined ? {} : { origin: request.sourceOrigin }), ...(request.capturedAt === undefined ? {} : { capturedAt: request.capturedAt }), references: request.references }, repositories, now: dependencies.now?.() });
      return { exitCode: 0, stdout: request.json ? asJson({ ok: true, workitem: metadata }) : `Created ${metadata.key} at workitems/${metadata.key}\n`, stderr: "" };
    }
    if (request.action === "status") {
      const report = await getWorkitemStatus(cwd, request.key);
      return { exitCode: 0, stdout: request.json ? asJson(report) : formatStatus(report), stderr: "" };
    }
    if (request.action === "drift") {
      const report = await compareWorkitemFingerprint(cwd, request.key, required({ positionals: [], values: new Map([["--fingerprint", [request.fingerprint ?? ""]]]), flags: new Set() }, "--fingerprint"));
      return { exitCode: report.state === "current" ? 0 : 3, stdout: asJson(report), stderr: "" };
    }
    if (request.action === "pause") {
      const record = await pauseWorkitem(cwd, { key: request.key, reason: request.reason ?? "paused by user", now: dependencies.now?.() });
      return { exitCode: 3, stdout: request.json ? asJson(record) : `Paused ${record.key}\n`, stderr: "" };
    }
    if (request.action === "resume") {
      const record = await resumeWorkitem(cwd, { key: request.key, fingerprint: request.fingerprint, now: dependencies.now?.() });
      return { exitCode: 0, stdout: request.json ? asJson(record) : `Resumed ${record.key}\n`, stderr: "" };
    }
    const record = await advanceWorkitem(cwd, { key: request.key, result: request.result ?? "", summary: request.summary ?? "", risk: request.risk ?? "", next: request.next ?? "", fingerprint: request.fingerprint, now: dependencies.now?.() });
    return { exitCode: record.to === "paused" ? 3 : 0, stdout: request.json ? asJson(record) : `${record.key}: ${record.from} -> ${record.to}\n`, stderr: "" };
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : "workitem command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return jsonRequested ? { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" } : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
