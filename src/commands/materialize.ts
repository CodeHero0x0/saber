import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import { materialize, type MaterializeOptions } from "../lib/materialize.js";
import type { RepositoryConfig, RoleName, ToolName } from "../lib/models.js";

export type MaterializeCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
};

export type MaterializeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function parseTool(value: string): ToolName {
  if (value === "codex" || value === "claude" || value === "opencode") {
    return value;
  }
  throw new SaberError("--tool must be codex, claude, or opencode", 2);
}

function parseRole(value: string): RoleName {
  if (value === "ba" || value === "dev" || value === "qa") {
    return value;
  }
  throw new SaberError("--role must be ba, dev, or qa", 2);
}

function parseRequest(argv: readonly string[]): MaterializeOptions & { json: boolean } {
  const values = new Map<string, string>();
  const capabilities: string[] = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) {
        throw new SaberError("duplicate flag --json", 2);
      }
      json = true;
      continue;
    }
    if (
      argument !== "--tool" &&
      argument !== "--role" &&
      argument !== "--project" &&
      argument !== "--capability"
    ) {
      throw new SaberError(argument?.startsWith("-") ? "unknown flag" : "unexpected positional argument", 2);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new SaberError(`${argument} requires a value`, 2);
    }
    if (argument === "--capability") {
      capabilities.push(value);
    } else {
      if (values.has(argument)) {
        throw new SaberError(`duplicate flag ${argument}`, 2);
      }
      values.set(argument, value);
    }
    index += 1;
  }
  const roleValue = values.get("--role");
  if (roleValue === undefined) {
    throw new SaberError("--role is required", 2);
  }
  const options: MaterializeOptions & { json: boolean } = {
    role: parseRole(roleValue),
    json,
  };
  const tool = values.get("--tool");
  const project = values.get("--project");
  if (tool !== undefined) {
    options.tool = parseTool(tool);
  }
  if (project !== undefined) {
    options.project = project;
  }
  if (capabilities.length > 0) {
    options.capabilities = capabilities;
  }
  return options;
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function runMaterializeCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: MaterializeCommandDependencies },
): Promise<MaterializeCommandResult> {
  const jsonRequested = argv.includes("--json");
  try {
    const request = parseRequest(argv);
    const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
    const result = await materialize(cwd, config, request);
    if (request.json) {
      return { exitCode: 0, stdout: asJson({ ok: true, runtime: result }), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `Materialized ${result.tool} for role ${result.role}${result.project === null ? "" : ` and project ${result.project}`}\n- Discovery: ${result.discoveryRoot}\n- Skills: ${result.projections.length}\n- Capabilities: ${result.capabilities.join(", ")}\n- MCP servers: ${result.mcpServers.length === 0 ? "none" : result.mcpServers.join(", ")}\n`,
      stderr: "",
    };
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : "materialize command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return jsonRequested
      ? { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" }
      : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
