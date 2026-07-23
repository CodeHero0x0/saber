import { copyFile, lstat, rm } from "node:fs/promises";
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

export type InitCommandResult = { exitCode: number; stdout: string; stderr: string };
export type InitCommandDependencies = ExternalAssetDependencies & {
  loadConfig?: (root: string) => Promise<RepositoryConfig>;
  runMaterialize?: typeof materialize;
  planExternal?: typeof planExternalAssetUpdates;
  updateExternal?: typeof executeExternalAssetUpdates;
};

type InitRequest = MaterializeOptions & { tool: ToolName; json: boolean };

function parseTool(value: string): ToolName {
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new SaberError("--tool must be codex, claude, or opencode", 2);
}

function parseRequest(argv: readonly string[]): InitRequest {
  let tool: ToolName | undefined;
  let project: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (json) throw new SaberError("duplicate flag --json", 2); json = true; continue; }
    if (argument !== "--tool" && argument !== "--project") throw new SaberError(argument?.startsWith("-") ? "unknown flag" : "unexpected positional argument", 2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) throw new SaberError(`${argument} requires a value`, 2);
    if (argument === "--tool") { if (tool !== undefined) throw new SaberError("duplicate flag --tool", 2); tool = parseTool(value); }
    else { if (project !== undefined) throw new SaberError("duplicate flag --project", 2); project = value; }
    index += 1;
  }
  if (tool === undefined) throw new SaberError("--tool is required", 2);
  return { tool, ...(project === undefined ? {} : { project }), json };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function ensureLocalConfig(root: string): Promise<boolean> {
  const destination = join(root, "saber.local.yaml");
  try { await lstat(destination); return false; } catch (error: unknown) { if (!isMissing(error)) throw error; }
  await copyFile(join(root, "saber.local.example.yaml"), destination, 1);
  return true;
}

function asJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

export async function runInitCommand(
  argv: readonly string[],
  { cwd, dependencies = {} }: { cwd: string; dependencies?: InitCommandDependencies },
): Promise<InitCommandResult> {
  const json = argv.includes("--json");
  let localCreated = false;
  try {
    const request = parseRequest(argv);
    localCreated = await ensureLocalConfig(cwd);
    const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
    const operations = await (dependencies.planExternal ?? planExternalAssetUpdates)(cwd, config.externalAssets);
    await (dependencies.updateExternal ?? executeExternalAssetUpdates)(cwd, config.externalAssets, operations, {
      fileSystem: dependencies.fileSystem,
      runner: dependencies.runner,
    });
    const installation = await (dependencies.runMaterialize ?? materialize)(cwd, config, request);
    const result = { ok: true, localCreated, installation };
    return request.json
      ? { exitCode: 0, stdout: asJson(result), stderr: "" }
      : { exitCode: 0, stdout: `Saber initialized for ${installation.tool}.\n- Command: /saber\n- Discovery: ${installation.discoveryRoot}\n- MCP servers: ${installation.mcpServers.length === 0 ? "none" : installation.mcpServers.join(", ")}\n`, stderr: "" };
  } catch (error: unknown) {
    if (localCreated) {
      await rm(join(cwd, "saber.local.yaml"), { force: true }).catch(() => undefined);
    }
    const message = error instanceof SaberError ? error.message : "init command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return json ? { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" } : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
