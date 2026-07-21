import { isAbsolute } from "node:path";

import type {
  Capability,
  RepositoryValidationInput,
  RiskLevel,
  ToolName,
} from "./models.js";

const environmentVariableName = /^[A-Z][A-Z0-9_]*$/u;
const toolNames: readonly ToolName[] = ["codex", "claude", "opencode"];
const riskLevels: readonly RiskLevel[] = ["L0", "L1", "L2", "L3"];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && toolNames.includes(value as ToolName);
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

  if (!isToolName(tools.default)) {
    errors.push(`unknown tool ${String(tools.default)}`);
  }

  for (const tool of tools.supported ?? []) {
    if (!isToolName(tool)) {
      errors.push(`unknown tool ${String(tool)}`);
    }
  }

  for (const duplicate of findDuplicateValues(tools.supported ?? [])) {
    errors.push(`duplicate supported tool ${duplicate}`);
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
  connectorIds: ReadonlySet<string>,
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

    if (capability.connector !== undefined && !connectorIds.has(capability.connector)) {
      errors.push(
        `capability ${capability.id} references missing connector ${capability.connector}`,
      );
    }
  }
}

function validateConnectors(input: RepositoryValidationInput, errors: string[]): void {
  const capabilityIds = new Set(input.capabilities.map((capability) => capability.id));

  for (const duplicate of findDuplicateValues(input.connectors.map((connector) => connector.id))) {
    errors.push(`duplicate connector id ${duplicate}`);
  }

  for (const connector of input.connectors) {
    for (const duplicate of findDuplicateValues(connector.requiredEnv)) {
      errors.push(`connector ${connector.id} repeats environment variable ${duplicate}`);
    }
    for (const name of connector.requiredEnv) {
      if (!environmentVariableName.test(name)) {
        errors.push(`connector ${connector.id} has invalid environment variable name ${name}`);
      }
    }

    for (const capabilityId of connector.provides) {
      if (!capabilityIds.has(capabilityId)) {
        errors.push(`connector ${connector.id} provides unknown capability ${capabilityId}`);
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
  const connectorIds = new Set(input.connectors.map((connector) => connector.id));

  if (input.workspace.schemaVersion !== 1) {
    errors.push("workspace schemaVersion must be 1");
  }

  validateTools(input, errors);
  validateProjects(input, errors);
  validateCapabilities(input.capabilities, connectorIds, errors);
  validateConnectors(input, errors);
  validateCapabilityReferences(input, errors);
  validateExternalAssets(input, errors);

  return errors;
}
