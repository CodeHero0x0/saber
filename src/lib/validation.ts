import { isAbsolute } from "node:path";

import type {
  Capability,
  ExternalAssetCategory,
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
const supportedGitProtocols = new Set(["https:", "http:", "ssh:", "git:"]);
const scpStyleGitRemote = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/:-]+$/u;
const externalPackagePathSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const terminalControlCharacter = /[\u0000-\u001f\u007f-\u009f]/u;

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
    !terminalControlCharacter.test(value)
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

/** URL userinfo and query strings can hold tokens, so they are not allowed in Git sources. */
export function externalAssetSourceContainsSensitiveUrlParts(source: unknown): boolean {
  if (typeof source !== "string") {
    return true;
  }

  try {
    const url = new URL(source);
    return Boolean(url.username || url.password || url.search || url.hash);
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

  return errors;
}
