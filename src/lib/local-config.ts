import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

import { SaberError } from "./errors.js";
import type { LocalConfig, RepositoryConfig, ToolName } from "./models.js";
import {
  isSafeExternalAssetId,
  isSafeExternalAssetSource,
  isToolName,
  parseMcpServers,
  validateMcpServerConfigs,
} from "./validation.js";

const localConfigFilename = "saber.local.yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SaberError(`${location} must be a YAML mapping`);
  }
  return value;
}

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

function optionalStringArray(value: unknown, location: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SaberError(`${location} must be a list of strings`);
  }
  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

function parseTool(value: unknown, location: string): ToolName {
  if (isToolName(value)) {
    return value;
  }
  throw new SaberError(`${location} must be codex, claude, or opencode`);
}

function parseLocalConfig(value: unknown, preset: RepositoryConfig): LocalConfig {
  const root = requireRecord(value, localConfigFilename);
  assertKnownKeys(root, localConfigFilename, [
    "schemaVersion",
    "defaults",
    "projects",
    "extensions",
    "mcp",
  ]);
  if (root.schemaVersion !== 2) {
    throw new SaberError(`${localConfigFilename}.schemaVersion must be 2`);
  }

  const defaults: LocalConfig["defaults"] = {};
  if (root.defaults !== undefined) {
    const record = requireRecord(root.defaults, `${localConfigFilename}.defaults`);
    assertKnownKeys(record, `${localConfigFilename}.defaults`, ["tool"]);
    if (record.tool !== undefined) {
      defaults.tool = parseTool(record.tool, `${localConfigFilename}.defaults.tool`);
    }
  }

  const projects: LocalConfig["projects"] = {};
  if (root.projects !== undefined) {
    const projectsRecord = requireRecord(root.projects, `${localConfigFilename}.projects`);
    const teamProjects = new Set(preset.workspace.projects.map((project) => project.name));
    for (const [name, projectValue] of Object.entries(projectsRecord)) {
      if (!teamProjects.has(name)) {
        throw new SaberError(`${localConfigFilename}.projects contains an unknown project`);
      }
      const project = requireRecord(
        projectValue,
        `${localConfigFilename}.projects project`,
      );
      assertKnownKeys(project, `${localConfigFilename}.projects project`, ["repository"]);
      const repository = requireString(
        project.repository,
        `${localConfigFilename}.projects repository`,
      );
      if (!isSafeExternalAssetSource(repository)) {
        throw new SaberError(`${localConfigFilename}.projects repository must be a safe Git remote`);
      }
      projects[name] = { repository };
    }
  }

  let skills: string[] = [];
  let prompts: string[] = [];
  let capabilities: string[] = [];
  let mcpServers: string[] = [];
  if (root.extensions !== undefined) {
    const extensions = requireRecord(root.extensions, `${localConfigFilename}.extensions`);
    assertKnownKeys(extensions, `${localConfigFilename}.extensions`, [
      "skills",
      "prompts",
      "capabilities",
      "mcpServers",
    ]);
    skills = optionalStringArray(extensions.skills, `${localConfigFilename}.extensions.skills`);
    prompts = optionalStringArray(extensions.prompts, `${localConfigFilename}.extensions.prompts`);
    capabilities = optionalStringArray(
      extensions.capabilities,
      `${localConfigFilename}.extensions.capabilities`,
    );
    mcpServers = optionalStringArray(
      extensions.mcpServers,
      `${localConfigFilename}.extensions.mcpServers`,
    );
  }

  for (const skill of skills) {
    if (!isSafeExternalAssetId(skill)) {
      throw new SaberError(`${localConfigFilename}.extensions contains an invalid skill id`);
    }
  }
  for (const prompt of prompts) {
    if (!isSafeExternalAssetId(prompt)) {
      throw new SaberError(`${localConfigFilename}.extensions contains an invalid prompt id`);
    }
  }

  const capabilitiesById = new Map(
    preset.capabilities.map((capability) => [capability.id, capability]),
  );
  for (const id of capabilities) {
    const capability = capabilitiesById.get(id);
    if (capability === undefined) {
      throw new SaberError(`${localConfigFilename}.extensions contains an unknown capability`);
    }
    if (capability.risk !== "L0" && capability.risk !== "L1") {
      throw new SaberError(
        `${localConfigFilename}.extensions capability must use risk level L0 or L1`,
      );
    }
  }

  const teamMcpServerIds = new Set(preset.mcp.servers.map((server) => server.id));
  const selectedMcpServers = new Set<string>();
  for (const id of mcpServers) {
    if (selectedMcpServers.has(id)) {
      throw new SaberError(`${localConfigFilename}.extensions repeats an MCP server`);
    }
    selectedMcpServers.add(id);
    if (!teamMcpServerIds.has(id)) {
      throw new SaberError(`${localConfigFilename}.extensions contains an unknown MCP server`);
    }
  }

  let personalMcpServers: LocalConfig["mcp"]["servers"] = [];
  if (root.mcp !== undefined) {
    const mcp = requireRecord(root.mcp, `${localConfigFilename}.mcp`);
    assertKnownKeys(mcp, `${localConfigFilename}.mcp`, ["servers"]);
    personalMcpServers = parseMcpServers(
      mcp.servers,
      `${localConfigFilename}.mcp.servers`,
    );
  }
  if (
    validateMcpServerConfigs(
      personalMcpServers,
      preset.capabilities,
      "personal configuration",
    ).length > 0
  ) {
    throw new SaberError(`${localConfigFilename}.mcp failed validation`);
  }
  for (const server of personalMcpServers) {
    if (teamMcpServerIds.has(server.id)) {
      throw new SaberError(`${localConfigFilename}.mcp cannot override a team MCP server`);
    }
    for (const tool of server.tools) {
      const capability = capabilitiesById.get(tool.capability);
      if (
        capability === undefined ||
        (capability.risk !== "L0" && capability.risk !== "L1")
      ) {
        throw new SaberError(
          `${localConfigFilename}.mcp capabilities must use risk level L0 or L1`,
        );
      }
    }
  }

  return {
    schemaVersion: 2,
    defaults,
    projects,
    extensions: { skills, prompts, capabilities, mcpServers },
    mcp: { servers: personalMcpServers },
  };
}

/** Missing local configuration is empty; an existing file must be a regular non-symlink. */
export async function loadLocalConfig(
  repositoryRoot: string,
  preset: RepositoryConfig,
): Promise<LocalConfig> {
  const path = join(repositoryRoot, localConfigFilename);
  let status;
  try {
    status = await lstat(path);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return {
        schemaVersion: 2,
        defaults: {},
        projects: {},
        extensions: { skills: [], prompts: [], capabilities: [], mcpServers: [] },
        mcp: { servers: [] },
      };
    }
    throw error;
  }
  if (status.isSymbolicLink()) {
    throw new SaberError(`${localConfigFilename} must not be a symbolic link`);
  }
  if (!status.isFile()) {
    throw new SaberError(`${localConfigFilename} must be a regular file`);
  }

  let value: unknown;
  try {
    value = parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SaberError) throw error;
    throw new SaberError(`could not parse ${localConfigFilename}`);
  }
  return parseLocalConfig(value, preset);
}
