import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";

import { SaberError } from "./errors.js";
import type { LocalConfig, RepositoryConfig, RoleName, ToolName } from "./models.js";
import {
  isSafeExternalAssetId,
  isSafeExternalAssetSource,
  isToolName,
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

function parseRole(value: unknown, location: string): RoleName {
  if (value === "ba" || value === "dev" || value === "qa") {
    return value;
  }
  throw new SaberError(`${location} must be ba, dev, or qa`);
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
  ]);
  if (root.schemaVersion !== 1) {
    throw new SaberError(`${localConfigFilename}.schemaVersion must be 1`);
  }

  const defaults: LocalConfig["defaults"] = {};
  if (root.defaults !== undefined) {
    const record = requireRecord(root.defaults, `${localConfigFilename}.defaults`);
    assertKnownKeys(record, `${localConfigFilename}.defaults`, ["role", "tool"]);
    if (record.role !== undefined) {
      defaults.role = parseRole(record.role, `${localConfigFilename}.defaults.role`);
    }
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
  if (root.extensions !== undefined) {
    const extensions = requireRecord(root.extensions, `${localConfigFilename}.extensions`);
    assertKnownKeys(extensions, `${localConfigFilename}.extensions`, ["skills", "prompts", "capabilities"]);
    skills = optionalStringArray(extensions.skills, `${localConfigFilename}.extensions.skills`);
    prompts = optionalStringArray(extensions.prompts, `${localConfigFilename}.extensions.prompts`);
    capabilities = optionalStringArray(
      extensions.capabilities,
      `${localConfigFilename}.extensions.capabilities`,
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

  return { schemaVersion: 1, defaults, projects, extensions: { skills, prompts, capabilities } };
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
        schemaVersion: 1,
        defaults: {},
        projects: {},
        extensions: { skills: [], prompts: [], capabilities: [] },
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
