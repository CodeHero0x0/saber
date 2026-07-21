import { parse } from "yaml";

import { SaberError } from "./errors.js";
import { readTextWithinRoot } from "./files.js";
import type {
  Capability,
  ConnectorConfig,
  ConnectorKind,
  ExternalAsset,
  ExternalAssetsConfig,
  ProjectConfig,
  RepositoryConfig,
  RiskLevel,
  SaberConfig,
  ToolName,
  WorkspaceConfig,
} from "./models.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SaberError(`${location} must be a YAML mapping`);
  }

  return value;
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

function requireSchemaVersion(record: Record<string, unknown>): 1 {
  if (record.schemaVersion !== 1) {
    throw new SaberError("saber.yaml.schemaVersion must be 1");
  }

  return 1;
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
  if (value === "http" || value === "mcp-command") {
    return value;
  }

  throw new SaberError(`${location} must be http or mcp-command`);
}

function parseYaml(text: string): unknown {
  try {
    return parse(text);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SaberError(`could not parse saber.yaml: ${reason}`);
  }
}

function parseSaberConfig(record: Record<string, unknown>, schemaVersion: 1): SaberConfig {
  const safety = requireRecord(record.safety, "saber.yaml.safety");
  const externalWrites = requireString(
    safety.externalWrites,
    "saber.yaml.safety.externalWrites",
  );

  if (externalWrites !== "preview-and-confirm") {
    throw new SaberError(
      "saber.yaml.safety.externalWrites must be preview-and-confirm",
    );
  }

  return {
    schemaVersion,
    name: requireString(record.name, "saber.yaml.name"),
    safety: {
      externalWrites,
      forbiddenRiskLevels: requireStringArray(
        safety.forbiddenRiskLevels,
        "saber.yaml.safety.forbiddenRiskLevels",
      ).map((risk, index) =>
        parseRiskLevel(risk, `saber.yaml.safety.forbiddenRiskLevels[${index}]`),
      ),
    },
  };
}

function parseProject(value: unknown, index: number): ProjectConfig {
  const location = `saber.yaml.workspace.projects[${index}]`;
  const record = requireRecord(value, location);
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
  const toolsRecord = requireRecord(record.tools, "saber.yaml.workspace.tools");
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

function parseExternalAsset(value: unknown, index: number): ExternalAsset {
  const location = `saber.yaml.externalAssets.assets[${index}]`;
  const record = requireRecord(value, location);
  const kind = requireString(record.kind, `${location}.kind`);

  if (kind !== "git") {
    throw new SaberError(`${location}.kind must be git`);
  }

  return {
    id: requireString(record.id, `${location}.id`),
    kind,
    source: requireString(record.source, `${location}.source`),
    destination: requireString(record.destination, `${location}.destination`),
  };
}

function parseExternalAssetsConfig(
  value: unknown,
  schemaVersion: 1,
): ExternalAssetsConfig {
  const record = requireRecord(value, "saber.yaml.externalAssets");
  if (!Array.isArray(record.assets)) {
    throw new SaberError("saber.yaml.externalAssets.assets must be a list");
  }

  return {
    schemaVersion,
    assets: record.assets.map((asset, index) => parseExternalAsset(asset, index)),
  };
}

/** Load the complete repository-level configuration from the single saber.yaml source. */
export async function loadRepositoryConfig(repositoryRoot: string): Promise<RepositoryConfig> {
  const root = requireRecord(
    parseYaml(await readTextWithinRoot(repositoryRoot, "saber.yaml")),
    "saber.yaml",
  );
  const schemaVersion = requireSchemaVersion(root);

  return {
    saber: parseSaberConfig(root, schemaVersion),
    workspace: parseWorkspaceConfig(root.workspace, schemaVersion),
    capabilities: parseCapabilities(root.capabilities),
    connectors: parseConnectors(root.connectors),
    externalAssets: parseExternalAssetsConfig(root.externalAssets, schemaVersion),
  };
}
