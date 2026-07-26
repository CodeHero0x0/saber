import { rm } from "node:fs/promises";
import { join } from "node:path";

import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import {
  executeExternalAssetUpdates,
  planExternalAssetUpdates,
  type ExternalAssetDependencies,
} from "../lib/external-assets.js";
import { materialize, type MaterializeOptions, type MaterializeResult } from "../lib/materialize.js";
import type { RepositoryConfig, ToolName } from "../lib/models.js";
import { scaffoldWorkspace, type ScaffoldResult } from "../lib/scaffold.js";

export type InitCommandResult = { exitCode: number; stdout: string; stderr: string };
export type InitCommandDependencies = ExternalAssetDependencies & {
  loadConfig?: (root: string) => Promise<RepositoryConfig>;
  runMaterialize?: typeof materialize;
  planExternal?: typeof planExternalAssetUpdates;
  updateExternal?: typeof executeExternalAssetUpdates;
  scaffold?: typeof scaffoldWorkspace;
};

type InitRequest = MaterializeOptions & { tool?: ToolName; json: boolean };

function parseTool(value: string): ToolName {
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new SaberError("--tool must be codex, claude, or opencode", 2);
}

function parseRequest(argv: readonly string[]): InitRequest {
  let tool: ToolName | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (json) throw new SaberError("duplicate flag --json", 2); json = true; continue; }
    if (argument !== "--tool") throw new SaberError(argument?.startsWith("-") ? "unknown flag" : "unexpected positional argument", 2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) throw new SaberError(`${argument} requires a value`, 2);
    if (tool !== undefined) throw new SaberError("duplicate flag --tool", 2);
    tool = parseTool(value);
    index += 1;
  }
  return { tool, json };
}

function asJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

export async function runInitCommand(
  argv: readonly string[],
  { cwd, dependencies = {} }: { cwd: string; dependencies?: InitCommandDependencies },
): Promise<InitCommandResult> {
  const json = argv.includes("--json");
  let scaffold: ScaffoldResult | undefined;
  try {
    const request = parseRequest(argv);
    scaffold = await (dependencies.scaffold ?? scaffoldWorkspace)(cwd);
    if (request.tool === undefined) {
      const result = { ok: true, scaffold, initializedTool: null };
      return request.json
        ? { exitCode: 0, stdout: asJson(result), stderr: "" }
        : { exitCode: 0, stdout: "Saber workspace scaffolded. Run saber init --tool <codex|claude|opencode> after completing local configuration.\n", stderr: "" };
    }
    const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
    const operations = await (dependencies.planExternal ?? planExternalAssetUpdates)(cwd, config.externalAssets);
    await (dependencies.updateExternal ?? executeExternalAssetUpdates)(cwd, config.externalAssets, operations, {
      fileSystem: dependencies.fileSystem,
      runner: dependencies.runner,
    });
    const installation = await (dependencies.runMaterialize ?? materialize)(cwd, config, request);
    const result = { ok: true, scaffold, installation };
    return request.json
      ? { exitCode: 0, stdout: asJson(result), stderr: "" }
      : { exitCode: 0, stdout: `Saber initialized for ${installation.tool}.\n- Command: /saber\n- Discovery: ${installation.discoveryRoot}\n- MCP servers: ${installation.mcpServers.length === 0 ? "none" : installation.mcpServers.join(", ")}\n`, stderr: "" };
  } catch (error: unknown) {
    if (scaffold?.created.includes("saber.local.yaml")) {
      await rm(join(cwd, "saber.local.yaml"), { force: true }).catch(() => undefined);
    }
    const message = error instanceof SaberError ? error.message : "init command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return json ? { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" } : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
