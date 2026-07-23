import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import { materialize, type MaterializeOptions } from "../lib/materialize.js";
import type { RepositoryConfig, ToolName } from "../lib/models.js";

export type MaterializeCommandDependencies = {
  loadConfig?: (root: string) => Promise<RepositoryConfig>;
  runMaterialize?: typeof materialize;
};
export type MaterializeCommandResult = { exitCode: number; stdout: string; stderr: string };

function parseTool(value: string): ToolName {
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new SaberError("--tool must be codex, claude, or opencode", 2);
}

function parseRequest(argv: readonly string[]): MaterializeOptions & { json: boolean } {
  const values = new Map<string, string>();
  const capabilities: string[] = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (json) throw new SaberError("duplicate flag --json", 2); json = true; continue; }
    if (argument !== "--tool" && argument !== "--project" && argument !== "--capability") {
      throw new SaberError(argument?.startsWith("-") ? "unknown flag" : "unexpected positional argument", 2);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) throw new SaberError(`${argument} requires a value`, 2);
    if (argument === "--capability") capabilities.push(value);
    else { if (values.has(argument)) throw new SaberError(`duplicate flag ${argument}`, 2); values.set(argument, value); }
    index += 1;
  }
  const tool = values.get("--tool");
  return {
    ...(tool === undefined ? {} : { tool: parseTool(tool) }),
    ...(values.get("--project") === undefined ? {} : { project: values.get("--project")! }),
    ...(capabilities.length === 0 ? {} : { capabilities }),
    json,
  };
}

function asJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

export async function runMaterializeCommand(
  argv: readonly string[],
  { cwd, dependencies = {} }: { cwd: string; dependencies?: MaterializeCommandDependencies },
): Promise<MaterializeCommandResult> {
  const json = argv.includes("--json");
  try {
    const request = parseRequest(argv);
    const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
    const result = await (dependencies.runMaterialize ?? materialize)(cwd, config, request);
    return request.json
      ? { exitCode: 0, stdout: asJson({ ok: true, installation: result }), stderr: "" }
      : {
          exitCode: 0,
          stdout: `Saber installed for ${result.tool}.\n- Discovery: ${result.discoveryRoot}\n- Commands: ${result.coreCommands.join(", ")}\n- Workflows: ${result.workflows.join(", ")}\n- MCP servers: ${result.mcpServers.length === 0 ? "none" : result.mcpServers.join(", ")}\n`,
          stderr: "",
        };
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : "materialize command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return json ? { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" } : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
