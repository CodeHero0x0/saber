import { parse } from "yaml";

import { SaberError } from "./errors.js";
import { readTextWithinRoot } from "./files.js";
import { loadLocalConfig } from "./local-config.js";
import type {
  Capability,
  ConnectorConfig,
  ConnectorKind,
  ExternalAsset,
  ExternalAssetCategory,
  ExternalAssetsConfig,
  ExternalAssetPackage,
  ProjectConfig,
  RepositoryConfig,
  RoleName,
  RoleProfile,
  RiskLevel,
  SaberConfig,
  ToolName,
  WorkspaceConfig,
} from "./models.js";
import { createStandardPreset } from "./presets.js";
import {
  isExternalAssetCategory,
  isSafeExternalAssetDescription,
  isSafeExternalAssetId,
  isSafeExternalAssetPackagePath,
  isSafeExternalAssetSource,
  validateRepositoryConfig,
} from "./validation.js";

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

function optionalString(value: unknown, location: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, location);
}

function requireStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new SaberError(`${location} must be a list of strings`);
  }

  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

function optionalStringArray(value: unknown, location: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireStringArray(value, location);
}

function parseRiskLevel(value: unknown, location: string): RiskLevel {
  if (value === "L0" || value === "L1" || value === "L2" || value === "L3") {
    return value;
  }

  throw new SaberError(`${location} must be one of L0, L1, L2, L3`);
}

function parseToolName(value: unknown, location: string): ToolName {
  if (value === "codex" || value === "claude" || value === "opencode") {
    return value;
  }

  throw new SaberError(`${location} must be one of codex, claude, opencode`);
}

function parseConnectorKind(value: unknown, location: string): ConnectorKind {
  if (value === "http" || value === "mcp-command" || value === "git-cli") {
    return value;
  }

  throw new SaberError(`${location} must be http, mcp-command, or git-cli`);
}

function parseExternalAssetCategory(
  value: unknown,
  location: string,
): ExternalAssetCategory {
  if (isExternalAssetCategory(value)) {
    return value;
  }

  throw new SaberError(`${location} must be skill-collection or mcp-server`);
}

function parseYaml(text: string): unknown {
  try {
    return parse(text);
  } catch {
    // YAML parser messages may reproduce source text. Do not echo configuration values.
    throw new SaberError("could not parse saber.yaml");
  }
}

function parseSaberConfig(record: Record<string, unknown>, schemaVersion: 1): SaberConfig {
  const safety = requireRecord(record.safety, "saber.yaml.safety");
  assertKnownKeys(safety, "saber.yaml.safety", ["externalWrites", "forbiddenRiskLevels"]);
  const externalWrites = requireString(
    safety.externalWrites,
    "saber.yaml.safety.externalWrites",
  );

  if (externalWrites !== "preview-and-confirm") {
    throw new SaberError(
      "saber.yaml.safety.externalWrites must be preview-and-confirm",
    );
  }

  const forbiddenRiskLevels = requireStringArray(
    safety.forbiddenRiskLevels,
    "saber.yaml.safety.forbiddenRiskLevels",
  ).map((risk, index) =>
    parseRiskLevel(risk, `saber.yaml.safety.forbiddenRiskLevels[${index}]`),
  );

  if (forbiddenRiskLevels.length !== 1 || forbiddenRiskLevels[0] !== "L3") {
    throw new SaberError("saber.yaml.safety.forbiddenRiskLevels must be exactly [L3]");
  }

  return {
    schemaVersion,
    name: requireString(record.name, "saber.yaml.name"),
    safety: {
      externalWrites,
      forbiddenRiskLevels,
    },
  };
}

function parseProject(value: unknown, index: number): ProjectConfig {
  const location = `saber.yaml.workspace.projects[${index}]`;
  const record = requireRecord(value, location);
  assertKnownKeys(record, location, ["name", "path", "repository", "capabilities"]);
  const project: ProjectConfig = {
    name: requireString(record.name, `${location}.name`),
    path: requireString(record.path, `${location}.path`),
  };
  const repository = optionalString(record.repository, `${location}.repository`);
  const capabilities = optionalStringArray(record.capabilities, `${location}.capabilities`);

  if (repository !== undefined) {
    project.repository = repository;
  }
  if (capabilities !== undefined) {
    project.capabilities = capabilities;
  }

  return project;
}

function parseWorkspaceConfig(value: unknown, schemaVersion: 1): WorkspaceConfig {
  const record = requireRecord(value, "saber.yaml.workspace");
  assertKnownKeys(record, "saber.yaml.workspace", ["tools", "projects"]);
  const toolsRecord = requireRecord(record.tools, "saber.yaml.workspace.tools");
  assertKnownKeys(toolsRecord, "saber.yaml.workspace.tools", [
    "default",
    "supported",
    "defaultCapabilities",
  ]);
  const tools: WorkspaceConfig["tools"] = {
    default: parseToolName(toolsRecord.default, "saber.yaml.workspace.tools.default"),
  };
  const supported = optionalStringArray(
    toolsRecord.supported,
    "saber.yaml.workspace.tools.supported",
  );
  const defaultCapabilities = optionalStringArray(
    toolsRecord.defaultCapabilities,
    "saber.yaml.workspace.tools.defaultCapabilities",
  );

  if (supported !== undefined) {
    tools.supported = supported.map((tool, index) =>
      parseToolName(tool, `saber.yaml.workspace.tools.supported[${index}]`),
    );
  }
  if (defaultCapabilities !== undefined) {
    tools.defaultCapabilities = defaultCapabilities;
  }

  if (!Array.isArray(record.projects)) {
    throw new SaberError("saber.yaml.workspace.projects must be a list");
  }

  return {
    schemaVersion,
    tools,
    projects: record.projects.map((project, index) => parseProject(project, index)),
  };
}

function parseCapability(value: unknown, index: number): Capability {
  const location = `saber.yaml.capabilities[${index}]`;
  const record = requireRecord(value, location);
  assertKnownKeys(record, location, ["id", "risk", "kind", "connector"]);
  const kind = requireString(record.kind, `${location}.kind`);

  if (kind !== "read" && kind !== "action") {
    throw new SaberError(`${location}.kind must be read or action`);
  }

  const connector = optionalString(record.connector, `${location}.connector`);
  const capability: Capability = {
    id: requireString(record.id, `${location}.id`),
    risk: parseRiskLevel(record.risk, `${location}.risk`),
    kind,
  };

  if (connector !== undefined) {
    capability.connector = connector;
  }

  return capability;
}

function parseCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value)) {
    throw new SaberError("saber.yaml.capabilities must be a list");
  }

  return value.map((capability, index) => parseCapability(capability, index));
}

function parseConnector(value: unknown, index: number): ConnectorConfig {
  const location = `saber.yaml.connectors[${index}]`;
  const record = requireRecord(value, location);
  assertKnownKeys(record, location, ["id", "kind", "requiredEnv", "provides"]);

  return {
    id: requireString(record.id, `${location}.id`),
    kind: parseConnectorKind(record.kind, `${location}.kind`),
    requiredEnv: requireStringArray(record.requiredEnv, `${location}.requiredEnv`),
    provides: requireStringArray(record.provides, `${location}.provides`),
  };
}

function parseConnectors(value: unknown): ConnectorConfig[] {
  if (!Array.isArray(value)) {
    throw new SaberError("saber.yaml.connectors must be a list");
  }

  return value.map((connector, index) => parseConnector(connector, index));
}

function parseRoleName(value: unknown, location: string): RoleName {
  if (value === "ba" || value === "dev" || value === "qa") {
    return value;
  }
  throw new SaberError(`${location} must be ba, dev, or qa`);
}

function parseRoleProfile(value: unknown, index: number): RoleProfile {
  const location = `saber.yaml.roleProfiles[${index}]`;
  const record = requireRecord(value, location);
  assertKnownKeys(record, location, [
    "id",
    "teamSkills",
    "externalSkills",
    "workflows",
    "capabilities",
  ]);
  return {
    id: parseRoleName(record.id, `${location}.id`),
    teamSkills: requireStringArray(record.teamSkills, `${location}.teamSkills`),
    externalSkills: requireStringArray(record.externalSkills, `${location}.externalSkills`),
    workflows: requireStringArray(record.workflows, `${location}.workflows`),
    capabilities: requireStringArray(record.capabilities, `${location}.capabilities`),
  };
}

function parseRoleProfiles(value: unknown): RoleProfile[] {
  if (!Array.isArray(value)) {
    throw new SaberError("saber.yaml.roleProfiles must be a list");
  }
  return value.map((profile, index) => parseRoleProfile(profile, index));
}

function parseExternalAsset(value: unknown, index: number): ExternalAsset {
  const location = `saber.yaml.externalAssets.assets[${index}]`;
  const record = requireRecord(value, location);
  assertKnownKeys(record, location, ["id", "category", "description", "kind", "source", "packages"]);
  const kind = requireString(record.kind, `${location}.kind`);

  if (kind !== "git") {
    throw new SaberError(`${location}.kind must be git`);
  }

  const id = requireString(record.id, `${location}.id`);
  const description = requireString(record.description, `${location}.description`);
  const source = requireString(record.source, `${location}.source`);
  const category = parseExternalAssetCategory(record.category, `${location}.category`);

  if (!isSafeExternalAssetId(id)) {
    throw new SaberError(`${location}.id must be a lowercase asset identifier`);
  }
  if (!isSafeExternalAssetDescription(description)) {
    throw new SaberError(`${location}.description must be a single safe line`);
  }
  if (!isSafeExternalAssetSource(source)) {
    throw new SaberError(`${location}.source must be a safe Git remote`);
  }
  if (!Array.isArray(record.packages) || record.packages.length === 0) {
    throw new SaberError(`${location}.packages must be a non-empty list`);
  }

  const packages = record.packages.map((selectedPackage, packageIndex) =>
    parseExternalAssetPackage(selectedPackage, index, packageIndex, category),
  );

  return {
    id,
    category,
    description,
    kind,
    source,
    packages,
  };
}

function parseExternalAssetPackage(
  value: unknown,
  assetIndex: number,
  packageIndex: number,
  category: ExternalAssetCategory,
): ExternalAssetPackage {
  const location = `saber.yaml.externalAssets.assets[${assetIndex}].packages[${packageIndex}]`;
  const record = requireRecord(value, location);
  assertKnownKeys(record, location, ["id", "sourcePath"]);
  const id = requireString(record.id, `${location}.id`);
  const sourcePath = requireString(record.sourcePath, `${location}.sourcePath`);

  if (!isSafeExternalAssetId(id)) {
    throw new SaberError(`${location}.id must be a lowercase package identifier`);
  }
  if (!isSafeExternalAssetPackagePath(sourcePath)) {
    throw new SaberError(`${location}.sourcePath must be a safe package subtree`);
  }
  if (category === "skill-collection" && !sourcePath.startsWith("skills/")) {
    throw new SaberError(`${location}.sourcePath must be below skills/ for a skill collection`);
  }

  return { id, sourcePath };
}

function parseExternalAssetsConfig(
  value: unknown,
  schemaVersion: 1,
): ExternalAssetsConfig {
  const record = requireRecord(value, "saber.yaml.externalAssets");
  assertKnownKeys(record, "saber.yaml.externalAssets", ["assets"]);
  if (!Array.isArray(record.assets)) {
    throw new SaberError("saber.yaml.externalAssets.assets must be a list");
  }

  return {
    schemaVersion,
    assets: record.assets.map((asset, index) => parseExternalAsset(asset, index)),
  };
}

function parseV1RepositoryConfig(root: Record<string, unknown>): RepositoryConfig {
  assertKnownKeys(root, "saber.yaml", [
    "schemaVersion",
    "name",
    "safety",
    "workspace",
    "capabilities",
    "connectors",
    "externalAssets",
    "roleProfiles",
  ]);
  return {
    saber: parseSaberConfig(root, 1),
    workspace: parseWorkspaceConfig(root.workspace, 1),
    capabilities: parseCapabilities(root.capabilities),
    connectors: parseConnectors(root.connectors),
    externalAssets: parseExternalAssetsConfig(root.externalAssets, 1),
    roleProfiles:
      root.roleProfiles === undefined ? [] : parseRoleProfiles(root.roleProfiles),
  };
}

function parseV2Project(value: unknown, index: number): ProjectConfig {
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

function parseV2TeamConfig(root: Record<string, unknown>): RepositoryConfig {
  assertKnownKeys(root, "saber.yaml", ["schemaVersion", "name", "workspace", "externalSkills"]);
  const workspace = requireRecord(root.workspace, "saber.yaml.workspace");
  assertKnownKeys(workspace, "saber.yaml.workspace", ["tools", "projects"]);
  if (!Array.isArray(workspace.projects)) {
    throw new SaberError("saber.yaml.workspace.projects must be a list");
  }

  const preset = createStandardPreset();
  preset.saber.name = requireString(root.name, "saber.yaml.name");
  preset.workspace.projects = workspace.projects.map((project, index) =>
    parseV2Project(project, index),
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
  return preset;
}

function assertValidResolvedConfig(config: RepositoryConfig): void {
  if (validateRepositoryConfig(config).length > 0) {
    // Cross-reference errors can contain user-controlled identifiers. Keep the
    // loading boundary generic so config values and credentials are never echoed.
    throw new SaberError("saber.yaml failed cross-configuration validation");
  }
}

/** Load and resolve repository configuration, including restricted local preferences for v2. */
export async function loadRepositoryConfig(repositoryRoot: string): Promise<RepositoryConfig> {
  const root = requireRecord(
    parseYaml(await readTextWithinRoot(repositoryRoot, "saber.yaml")),
    "saber.yaml",
  );
  if (root.schemaVersion === 1) {
    const config = parseV1RepositoryConfig(root);
    assertValidResolvedConfig(config);
    return config;
  }
  if (root.schemaVersion !== 2) {
    throw new SaberError("saber.yaml.schemaVersion must be 1 or 2");
  }

  const config = parseV2TeamConfig(root);
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
