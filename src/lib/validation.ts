import { isAbsolute } from "node:path";

import { SaberError } from "./errors.js";
import type {
  Capability,
  ExternalAssetCategory,
  McpServerConfig,
  McpToolConfig,
  RepositoryValidationInput,
  RiskLevel,
  ToolName,
} from "./models.js";

const environmentVariableName = /^[A-Z][A-Z0-9_]*$/u;
const toolNames: readonly ToolName[] = ["codex", "claude", "opencode"];
const riskLevels: readonly RiskLevel[] = ["L0", "L1", "L2", "L3"];
const externalAssetCategories: readonly ExternalAssetCategory[] = [
  "skill-collection",
  "mcp-server",
];
const externalAssetId = /^[a-z][a-z0-9-]{0,63}$/u;
const supportedGitProtocols = new Set(["https:", "ssh:"]);
const scpStyleGitRemote = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/:-]+$/u;
const sshUsername = /^[A-Za-z0-9._-]+$/u;
const externalPackagePathSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const fixedRemoteWriteCapabilities = new Set([
  "jira.update",
  "gitlab.mr.create",
  "git.push",
  "mysql.write",
  "idea.command.execute",
]);
// These characters can alter terminal rendering, conceal suffixes, or split a
// displayed line. Reject them before a description is printed or a source is
// parsed into Git argv.
const unsafeTerminalCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const httpHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function containsUnsafeTerminalCharacter(value: string): boolean {
  return unsafeTerminalCharacter.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireMcpRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SaberError(`${location} must be a YAML mapping`);
  }
  return value;
}

function assertMcpKnownKeys(
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

function requireMcpString(value: unknown, location: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    containsUnsafeTerminalCharacter(value)
  ) {
    throw new SaberError(`${location} must be a non-empty safe string`);
  }
  return value;
}

function parseMcpStringArray(value: unknown, location: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SaberError(`${location} must be a list of strings`);
  }
  return value.map((item, index) => requireMcpString(item, `${location}[${index}]`));
}

function parseEnvironmentVariableNames(value: unknown, location: string): string[] {
  const names = parseMcpStringArray(value, location);
  for (const name of names) {
    if (!environmentVariableName.test(name)) {
      throw new SaberError(`${location} values must name environment variables`);
    }
  }
  return names;
}

function parseEnvironmentReferences(
  value: unknown,
  location: string,
  keyKind: "environment variable" | "HTTP header",
): Record<string, string> {
  if (value === undefined) return {};
  const record = requireMcpRecord(value, location);
  const result: Record<string, string> = {};
  for (const [key, source] of Object.entries(record)) {
    if (
      (keyKind === "environment variable" && !environmentVariableName.test(key)) ||
      (keyKind === "HTTP header" && !httpHeaderName.test(key))
    ) {
      throw new SaberError(`${location} contains an invalid ${keyKind} name`);
    }
    const sourceName = requireMcpString(source, `${location}.${key}`);
    if (!environmentVariableName.test(sourceName)) {
      throw new SaberError(`${location} values must name environment variables`);
    }
    result[key] = sourceName;
  }
  return result;
}

function parseMcpTools(value: unknown, location: string): McpToolConfig[] {
  if (!Array.isArray(value)) {
    throw new SaberError(`${location} must be a list`);
  }
  return value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    const record = requireMcpRecord(item, itemLocation);
    assertMcpKnownKeys(record, itemLocation, ["name", "capability"]);
    return {
      name: requireMcpString(record.name, `${itemLocation}.name`),
      capability: requireMcpString(record.capability, `${itemLocation}.capability`),
    };
  });
}

/** Parse MCP servers as a strict discriminated union and normalize optional collections. */
export function parseMcpServers(value: unknown, location: string): McpServerConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SaberError(`${location} must be a list`);
  }

  return value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    const record = requireMcpRecord(item, itemLocation);
    if (record.transport === "stdio") {
      assertMcpKnownKeys(record, itemLocation, [
        "id",
        "transport",
        "command",
        "args",
        "cwd",
        "env",
        "tools",
      ]);
      const cwd =
        record.cwd === undefined
          ? undefined
          : requireMcpString(record.cwd, `${itemLocation}.cwd`);
      return {
        id: requireMcpString(record.id, `${itemLocation}.id`),
        transport: "stdio",
        command: requireMcpString(record.command, `${itemLocation}.command`),
        args: parseMcpStringArray(record.args, `${itemLocation}.args`),
        ...(cwd === undefined ? {} : { cwd }),
        env: parseEnvironmentVariableNames(record.env, `${itemLocation}.env`),
        tools: parseMcpTools(record.tools, `${itemLocation}.tools`),
      };
    }
    if (record.transport === "http") {
      assertMcpKnownKeys(record, itemLocation, [
        "id",
        "transport",
        "url",
        "headers",
        "tools",
      ]);
      return {
        id: requireMcpString(record.id, `${itemLocation}.id`),
        transport: "http",
        url: requireMcpString(record.url, `${itemLocation}.url`),
        headers: parseEnvironmentReferences(
          record.headers,
          `${itemLocation}.headers`,
          "HTTP header",
        ),
        tools: parseMcpTools(record.tools, `${itemLocation}.tools`),
      };
    }
    throw new SaberError(`${itemLocation}.transport must be stdio or http`);
  });
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && toolNames.includes(value as ToolName);
}

/** Return whether an asset uses one of the registry categories understood by Saber. */
export function isExternalAssetCategory(value: unknown): value is ExternalAssetCategory {
  return (
    typeof value === "string" &&
    externalAssetCategories.includes(value as ExternalAssetCategory)
  );
}

/** Asset identifiers are stable selectors, never relative paths or arbitrary shell input. */
export function isSafeExternalAssetId(value: unknown): value is string {
  return typeof value === "string" && externalAssetId.test(value);
}

/** Descriptions are emitted in the human CLI, so keep them single-line and terminal-safe. */
export function isSafeExternalAssetDescription(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !containsUnsafeTerminalCharacter(value)
  );
}

/** Source package paths select a subtree; they can never select an upstream root or parent path. */
export function isSafeExternalAssetPackagePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\")) {
    return false;
  }

  const segments = value.split("/");
  if (segments.length < 2) {
    return false;
  }

  return segments.every((segment) => externalPackagePathSegment.test(segment));
}

/** HTTPS userinfo and URL secrets are never allowed; SSH may use a simple account name. */
export function externalAssetSourceContainsSensitiveUrlParts(source: unknown): boolean {
  if (typeof source !== "string") {
    return true;
  }

  try {
    const url = new URL(source);
    return Boolean(
      url.password ||
        url.search ||
        url.hash ||
        (url.username && (url.protocol !== "ssh:" || !sshUsername.test(url.username))),
    );
  } catch {
    return false;
  }
}

/**
 * Git source values are data, not command fragments. Permit standard remote
 * URLs and scp-style SSH remotes, but never local paths or option-looking text.
 */
export function isSafeExternalAssetSource(source: unknown): source is string {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.trim() !== source ||
    containsUnsafeTerminalCharacter(source) ||
    source.startsWith("-")
  ) {
    return false;
  }

  try {
    const url = new URL(source);
    return (
      supportedGitProtocols.has(url.protocol) &&
      url.hostname.length > 0 &&
      !externalAssetSourceContainsSensitiveUrlParts(source)
    );
  } catch {
    return scpStyleGitRemote.test(source);
  }
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && riskLevels.includes(value as RiskLevel);
}

function findDuplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates];
}

function isUnsafeProjectPath(projectPath: string): boolean {
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(projectPath) || projectPath.startsWith("\\\\");
  return (
    projectPath.length === 0 ||
    isAbsolute(projectPath) ||
    isWindowsAbsolute ||
    projectPath.split(/[\\/]+/u).includes("..")
  );
}

export function isSafeMcpCwd(cwd: string): boolean {
  return cwd === "." || (!isUnsafeProjectPath(cwd) && cwd.trim() === cwd);
}

function isSafeMcpCommand(command: string): boolean {
  if (containsUnsafeTerminalCharacter(command) || /\s/u.test(command)) return false;
  if (!/[\\/]/u.test(command)) return true;
  return !isUnsafeProjectPath(command);
}

export function isSafeMcpHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function validateMcpServers(
  servers: readonly McpServerConfig[],
  capabilities: readonly Capability[],
  errors: string[],
  scope: string,
): void {
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  const capabilitiesById = new Map(capabilities.map((capability) => [capability.id, capability]));
  for (const duplicate of findDuplicateValues(servers.map((server) => server.id))) {
    errors.push(`${scope} repeats MCP server id ${duplicate}`);
  }

  for (const server of servers) {
    if (!isSafeExternalAssetId(server.id)) {
      errors.push(`${scope} MCP server has invalid id`);
    }
    for (const duplicate of findDuplicateValues(server.tools.map((tool) => tool.name))) {
      errors.push(`${scope} MCP server ${server.id} repeats tool ${duplicate}`);
    }
    for (const duplicate of findDuplicateValues(server.tools.map((tool) => tool.capability))) {
      errors.push(`${scope} MCP server ${server.id} repeats capability ${duplicate}`);
    }
    for (const tool of server.tools) {
      if (!capabilityIds.has(tool.capability)) {
        errors.push(`${scope} MCP server ${server.id} references unknown capability`);
      } else {
        const capability = capabilitiesById.get(tool.capability)!;
        if (capability.risk !== "L0" && capability.risk !== "L1") {
          errors.push(`${scope} MCP server ${server.id} cannot expose L2/L3 capability through native MCP`);
        }
      }
    }

    if (server.transport === "stdio") {
      if (!isSafeMcpCommand(server.command)) {
        errors.push(`${scope} MCP server ${server.id} command must be a safe executable`);
      }
      if (server.cwd !== undefined && !isSafeMcpCwd(server.cwd)) {
        errors.push(`${scope} MCP server ${server.id} has unsafe cwd`);
      }
      for (const name of server.env) {
        if (!environmentVariableName.test(name)) {
          errors.push(`${scope} MCP server ${server.id} has invalid environment reference`);
        }
      }
      for (const duplicate of findDuplicateValues(server.env)) {
        errors.push(`${scope} MCP server ${server.id} repeats environment variable ${duplicate}`);
      }
    } else {
      if (!isSafeMcpHttpUrl(server.url)) {
        errors.push(`${scope} MCP server ${server.id} has unsafe URL`);
      }
      for (const [name, source] of Object.entries(server.headers)) {
        if (!httpHeaderName.test(name) || !environmentVariableName.test(source)) {
          errors.push(`${scope} MCP server ${server.id} has invalid header reference`);
        }
      }
    }
  }
}

/** Validate a standalone MCP collection, including capability cross-references. */
export function validateMcpServerConfigs(
  servers: readonly McpServerConfig[],
  capabilities: readonly Capability[],
  scope = "configuration",
): string[] {
  const errors: string[] = [];
  validateMcpServers(servers, capabilities, errors, scope);
  return errors;
}

function validateTools(input: RepositoryValidationInput, errors: string[]): void {
  const tools = input.workspace.tools;
  const supportedTools = tools.supported ?? [];

  if (!isToolName(tools.default)) {
    errors.push(`unknown tool ${String(tools.default)}`);
  }

  for (const tool of supportedTools) {
    if (!isToolName(tool)) {
      errors.push(`unknown tool ${String(tool)}`);
    }
  }

  for (const duplicate of findDuplicateValues(supportedTools)) {
    errors.push(`duplicate supported tool ${duplicate}`);
  }

  if (supportedTools.length > 0 && !supportedTools.includes(tools.default)) {
    errors.push(`default tool ${String(tools.default)} is not included in supported tools`);
  }
}

function validateProjects(input: RepositoryValidationInput, errors: string[]): void {
  for (const project of input.workspace.projects) {
    if (isUnsafeProjectPath(project.path)) {
      errors.push(`project ${project.name} has unsafe path ${project.path}`);
    }
    // Project clone sources use the exact same allow-list as sparse external
    // assets. Never accept a local path, option-like text, insecure protocol,
    // or URL userinfo that could carry a credential.
    if (
      project.repository !== undefined &&
      !isSafeExternalAssetSource(project.repository)
    ) {
      errors.push(`project ${project.name} has unsafe repository`);
    }
  }

  for (const duplicate of findDuplicateValues(
    input.workspace.projects.map((project) => project.name),
  )) {
    errors.push(`duplicate project name ${duplicate}`);
  }
}

function validateCapabilities(
  capabilities: readonly Capability[],
  connectorsById: ReadonlyMap<string, RepositoryValidationInput["connectors"][number]>,
  errors: string[],
): void {
  for (const duplicate of findDuplicateValues(capabilities.map((capability) => capability.id))) {
    errors.push(`duplicate capability id ${duplicate}`);
  }

  for (const capability of capabilities) {
    if (!isRiskLevel(capability.risk)) {
      errors.push(`capability ${capability.id} has invalid risk level ${String(capability.risk)}`);
    } else if (capability.risk === "L3") {
      errors.push(`capability ${capability.id} uses forbidden risk level L3`);
    }

    if (
      fixedRemoteWriteCapabilities.has(capability.id) &&
      (capability.risk !== "L2" || capability.kind !== "action")
    ) {
      errors.push(`capability ${capability.id} must use risk level L2 and kind action`);
    }

    if (capability.connector !== undefined) {
      const connector = connectorsById.get(capability.connector);

      if (connector === undefined) {
        errors.push(
          `capability ${capability.id} references missing connector ${capability.connector}`,
        );
      } else if (!connector.provides.includes(capability.id)) {
        errors.push(
          `capability ${capability.id} is not provided by connector ${capability.connector}`,
        );
      }
    }
  }
}

function validateConnectors(input: RepositoryValidationInput, errors: string[]): void {
  const capabilitiesById = new Map<string, Capability>();
  for (const capability of input.capabilities) {
    if (!capabilitiesById.has(capability.id)) {
      capabilitiesById.set(capability.id, capability);
    }
  }

  for (const duplicate of findDuplicateValues(input.connectors.map((connector) => connector.id))) {
    errors.push(`duplicate connector id ${duplicate}`);
  }

  for (const connector of input.connectors) {
    for (const duplicate of findDuplicateValues(connector.requiredEnv)) {
      errors.push(`connector ${connector.id} repeats environment variable ${duplicate}`);
    }
    for (const duplicate of findDuplicateValues(connector.provides)) {
      errors.push(`connector ${connector.id} repeats provided capability ${duplicate}`);
    }
    for (const name of connector.requiredEnv) {
      if (!environmentVariableName.test(name)) {
        errors.push(`connector ${connector.id} has invalid environment variable name ${name}`);
      }
    }

    for (const capabilityId of new Set(connector.provides)) {
      const capability = capabilitiesById.get(capabilityId);

      if (capability === undefined) {
        errors.push(`connector ${connector.id} provides unknown capability ${capabilityId}`);
      } else if (capability.connector === undefined) {
        errors.push(
          `connector ${connector.id} provides connectorless capability ${capabilityId}`,
        );
      } else if (capability.connector !== connector.id) {
        errors.push(
          `connector ${connector.id} provides capability ${capabilityId} mapped to connector ${capability.connector}`,
        );
      }
    }
  }
}

function validateExternalAssets(input: RepositoryValidationInput, errors: string[]): void {
  if (input.externalAssets === undefined) {
    return;
  }

  for (const duplicate of findDuplicateValues(
    input.externalAssets.assets.map((asset) => asset.id),
  )) {
    errors.push(`duplicate external asset id ${duplicate}`);
  }

  for (const asset of input.externalAssets.assets) {
    if (!isSafeExternalAssetId(asset.id)) {
      errors.push(`invalid external asset id ${asset.id}`);
    }
    if (!isExternalAssetCategory(asset.category)) {
      errors.push(`external asset ${asset.id} has unknown category`);
    }
    if (asset.kind !== "git") {
      errors.push(`external asset ${asset.id} has unsupported kind`);
    }
    if (!isSafeExternalAssetDescription(asset.description)) {
      errors.push(`external asset ${asset.id} description must be a single safe line`);
    }
    if (!isSafeExternalAssetSource(asset.source)) {
      errors.push(`external asset ${asset.id} source must be a safe Git remote`);
    }
    if (!Array.isArray(asset.packages) || asset.packages.length === 0) {
      errors.push(`external asset ${asset.id} must select at least one package`);
      continue;
    }

    const packageIds = new Set<string>();
    const packagePaths = new Set<string>();
    for (const selectedPackage of asset.packages) {
      if (!isSafeExternalAssetId(selectedPackage.id)) {
        errors.push(`external asset ${asset.id} has an invalid package id`);
      } else if (packageIds.has(selectedPackage.id)) {
        errors.push(`external asset ${asset.id} repeats package id ${selectedPackage.id}`);
      }
      packageIds.add(selectedPackage.id);

      const safeSourcePath = isSafeExternalAssetPackagePath(selectedPackage.sourcePath);
      if (!safeSourcePath) {
        errors.push(`external asset ${asset.id} has an invalid package source path`);
      } else if (packagePaths.has(selectedPackage.sourcePath)) {
        errors.push(`external asset ${asset.id} repeats package source path ${selectedPackage.sourcePath}`);
      }
      packagePaths.add(selectedPackage.sourcePath);

      if (
        asset.category === "skill-collection" &&
        (!safeSourcePath || !selectedPackage.sourcePath.startsWith("skills/"))
      ) {
        errors.push(`external skill asset ${asset.id} package must be below skills/`);
      }
    }
  }
}

function validateCapabilityReferences(input: RepositoryValidationInput, errors: string[]): void {
  const capabilityIds = new Set(input.capabilities.map((capability) => capability.id));

  for (const capabilityId of input.workspace.tools.defaultCapabilities ?? []) {
    if (!capabilityIds.has(capabilityId)) {
      errors.push(`workspace default capability ${capabilityId} is not declared`);
    }
  }

  for (const project of input.workspace.projects) {
    for (const capabilityId of project.capabilities ?? []) {
      if (!capabilityIds.has(capabilityId)) {
        errors.push(`project ${project.name} references unknown capability ${capabilityId}`);
      }
    }
  }
}

function validateRoleProfiles(input: RepositoryValidationInput, errors: string[]): void {
  if (input.roleProfiles === undefined) {
    return;
  }
  const capabilityIds = new Set(input.capabilities.map((capability) => capability.id));
  const selectedExternalSkills = new Set(
    (input.externalAssets?.assets ?? []).flatMap((asset) =>
      asset.packages.map((selectedPackage) => `${asset.id}/${selectedPackage.id}`),
    ),
  );
  for (const duplicate of findDuplicateValues(input.roleProfiles.map((profile) => profile.id))) {
    errors.push(`duplicate role profile ${duplicate}`);
  }
  for (const profile of input.roleProfiles) {
    for (const collection of [
      ["team skill", profile.teamSkills],
      ["workflow", profile.workflows],
      ["capability", profile.capabilities],
      ["external skill", profile.externalSkills],
    ] as const) {
      for (const duplicate of findDuplicateValues(collection[1])) {
        errors.push(`role ${profile.id} repeats ${collection[0]} ${duplicate}`);
      }
    }
    for (const capabilityId of profile.capabilities) {
      if (!capabilityIds.has(capabilityId)) {
        errors.push(`role ${profile.id} references unknown capability ${capabilityId}`);
      }
    }
    for (const skillId of profile.externalSkills) {
      if (!selectedExternalSkills.has(skillId)) {
        errors.push(`role ${profile.id} references unknown external skill ${skillId}`);
      }
    }
  }
}

/** Validate the references and safety invariants shared by all Saber commands. */
export function validateRepositoryConfig(input: RepositoryValidationInput): string[] {
  const errors: string[] = [];
  const connectorsById = new Map<string, RepositoryValidationInput["connectors"][number]>();
  for (const connector of input.connectors) {
    if (!connectorsById.has(connector.id)) {
      connectorsById.set(connector.id, connector);
    }
  }

  if (input.workspace.schemaVersion !== 1) {
    errors.push("workspace schemaVersion must be 1");
  }

  validateTools(input, errors);
  validateProjects(input, errors);
  validateCapabilities(input.capabilities, connectorsById, errors);
  validateConnectors(input, errors);
  validateCapabilityReferences(input, errors);
  validateExternalAssets(input, errors);
  validateRoleProfiles(input, errors);
  validateMcpServers(input.mcp?.servers ?? [], input.capabilities, errors, "team configuration");

  return errors;
}
