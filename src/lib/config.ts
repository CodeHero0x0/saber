import { parse } from "yaml";

import { SaberError } from "./errors.js";
import { readTextWithinRoot } from "./files.js";
import { loadLocalConfig } from "./local-config.js";
import type { ProjectConfig, RepositoryConfig, ToolName } from "./models.js";
import { createStandardPreset } from "./presets.js";
import { parseMcpServers, validateRepositoryConfig } from "./validation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SaberError(`${location} must be a YAML mapping`);
  }
  return value;
}

/** Reject unrecognized fields so credentials and endpoint values cannot be silently ignored. */
function assertKnownKeys(
  record: Record<string, unknown>,
  location: string,
  knownKeys: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!knownKeys.includes(key)) {
      throw new SaberError(`${location} contains an unknown key`);
    }
  }
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SaberError(`${location} must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(value: unknown, location: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SaberError(`${location} must be a list of strings`);
  }
  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

function parseToolName(value: unknown, location: string): ToolName {
  if (value === "codex" || value === "claude" || value === "opencode") {
    return value;
  }
  throw new SaberError(`${location} must be one of codex, claude, opencode`);
}

function parseYaml(text: string): unknown {
  try {
    return parse(text);
  } catch {
    // YAML parser messages may reproduce source text. Do not echo configuration values.
    throw new SaberError("could not parse saber.yaml");
  }
}

function parseProject(value: unknown, index: number): ProjectConfig {
  const location = `saber.yaml.workspace.projects[${index}]`;
  const record = requireRecord(value, location);
  assertKnownKeys(record, location, ["name", "path", "capabilities"]);
  const capabilities = optionalStringArray(record.capabilities, `${location}.capabilities`);
  return {
    name: requireString(record.name, `${location}.name`),
    path: requireString(record.path, `${location}.path`),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function parseTeamConfig(root: Record<string, unknown>): RepositoryConfig {
  assertKnownKeys(root, "saber.yaml", [
    "schemaVersion",
    "name",
    "workspace",
    "externalSkills",
    "mcp",
  ]);
  const workspace = requireRecord(root.workspace, "saber.yaml.workspace");
  assertKnownKeys(workspace, "saber.yaml.workspace", ["tools", "projects"]);
  if (!Array.isArray(workspace.projects)) {
    throw new SaberError("saber.yaml.workspace.projects must be a list");
  }

  const preset = createStandardPreset();
  preset.saber.name = requireString(root.name, "saber.yaml.name");
  preset.workspace.projects = workspace.projects.map((project, index) =>
    parseProject(project, index),
  );

  if (workspace.tools !== undefined) {
    const tools = requireRecord(workspace.tools, "saber.yaml.workspace.tools");
    assertKnownKeys(tools, "saber.yaml.workspace.tools", ["default"]);
    if (tools.default !== undefined) {
      preset.workspace.tools.default = parseToolName(
        tools.default,
        "saber.yaml.workspace.tools.default",
      );
    }
  }

  const externalSkills = requireRecord(root.externalSkills, "saber.yaml.externalSkills");
  assertKnownKeys(externalSkills, "saber.yaml.externalSkills", ["preset"]);
  if (externalSkills.preset !== "standard") {
    throw new SaberError("saber.yaml.externalSkills.preset must be standard");
  }

  if (root.mcp !== undefined) {
    const mcp = requireRecord(root.mcp, "saber.yaml.mcp");
    assertKnownKeys(mcp, "saber.yaml.mcp", ["servers"]);
    preset.mcp.servers = parseMcpServers(mcp.servers, "saber.yaml.mcp.servers");
  }
  return preset;
}

function assertValidResolvedConfig(config: RepositoryConfig): void {
  if (validateRepositoryConfig(config).length > 0) {
    // Cross-reference errors can contain user-controlled identifiers.
    throw new SaberError("saber.yaml failed cross-configuration validation");
  }
}

/** Load the current team schema and merge restricted member-specific preferences. */
export async function loadRepositoryConfig(repositoryRoot: string): Promise<RepositoryConfig> {
  const root = requireRecord(
    parseYaml(await readTextWithinRoot(repositoryRoot, "saber.yaml")),
    "saber.yaml",
  );
  if (root.schemaVersion !== 3) {
    throw new SaberError("saber.yaml.schemaVersion must be 3");
  }

  const config = parseTeamConfig(root);
  const local = await loadLocalConfig(repositoryRoot, config);
  if (local.defaults.tool !== undefined) {
    config.workspace.tools.default = local.defaults.tool;
  }
  for (const project of config.workspace.projects) {
    const override = local.projects[project.name];
    if (override !== undefined) project.repository = override.repository;
  }
  config.local = local;
  assertValidResolvedConfig(config);
  return config;
}
