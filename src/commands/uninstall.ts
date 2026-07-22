import { SaberError } from "../lib/errors.js";
import type { ToolName } from "../lib/models.js";
import {
  uninstall,
  type UninstallRequest,
  type UninstallResult,
} from "../lib/uninstall.js";

export type UninstallCommandDependencies = {
  runUninstall?: typeof uninstall;
};

export type UninstallCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function parseTool(value: string): ToolName {
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new SaberError("--tool must be codex, claude, or opencode", 2);
}

function parseRequest(argv: readonly string[]): UninstallRequest & { json: boolean } {
  let all = false;
  let apply = false;
  let json = false;
  let tool: ToolName | undefined;
  let project: string | undefined;
  let confirm: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all" || argument === "--apply" || argument === "--json") {
      const alreadySet = argument === "--all" ? all : argument === "--apply" ? apply : json;
      if (alreadySet) throw new SaberError(`duplicate flag ${argument}`, 2);
      if (argument === "--all") all = true;
      if (argument === "--apply") apply = true;
      if (argument === "--json") json = true;
      continue;
    }
    if (argument !== "--tool" && argument !== "--project" && argument !== "--confirm") {
      throw new SaberError(argument?.startsWith("-") ? "unknown flag" : "unexpected positional argument", 2);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new SaberError(`${argument} requires a value`, 2);
    }
    if (argument === "--tool") {
      if (tool !== undefined) throw new SaberError("duplicate flag --tool", 2);
      tool = parseTool(value);
    } else if (argument === "--project") {
      if (project !== undefined) throw new SaberError("duplicate flag --project", 2);
      project = value;
    } else {
      if (confirm !== undefined) throw new SaberError("duplicate flag --confirm", 2);
      confirm = value;
    }
    index += 1;
  }
  return { all, apply, json, ...(tool === undefined ? {} : { tool }), ...(project === undefined ? {} : { project }), ...(confirm === undefined ? {} : { confirm }) };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function plain(result: UninstallResult): string {
  const mode = result.applied ? "已卸载" : "卸载预览";
  const targets = result.plan.targets.length === 0
    ? "无已安装目标"
    : result.plan.targets.map((target) => `${target.tool}/${target.target}`).join(", ");
  return `${mode}\n- 目标: ${targets}\n- 确认令牌: ${result.plan.confirmationToken}\n`;
}

export async function runUninstallCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: UninstallCommandDependencies },
): Promise<UninstallCommandResult> {
  const jsonRequested = argv.includes("--json");
  try {
    const request = parseRequest(argv);
    const result = await (dependencies.runUninstall ?? uninstall)(cwd, request);
    return {
      exitCode: 0,
      stdout: request.json ? json({ ok: true, ...result }) : plain(result),
      stderr: "",
    };
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : "uninstall command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return jsonRequested
      ? { exitCode, stdout: json({ ok: false, errors: [message] }), stderr: "" }
      : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
