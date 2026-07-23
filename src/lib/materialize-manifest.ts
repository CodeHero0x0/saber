import { readFile } from "node:fs/promises";

import { SaberError } from "./errors.js";
import type { ToolName } from "./models.js";
import { validateManagedEntries, type ManagedMcpEntry } from "./tool-configs/index.js";

export type ProjectionKind =
  | "core-command"
  | "team-skill"
  | "personal-prompt"
  | "workflow"
  | "external-skill";

export type MaterializeProjection = {
  name: string;
  kind: ProjectionKind;
  linkPath: string;
  sourcePath: string;
  sourceDigest: string | null;
  linkTarget: string;
};

export type MaterializeToolConfig = {
  path: string;
  existedBefore: boolean;
  createdBySaber: boolean;
  digest: string | null;
};

export type MaterializeSourceFingerprints = {
  team: string;
  local: string | null;
  external: string | null;
};

export type RuntimeManifest = {
  schemaVersion: 4;
  managedBy: "saber";
  tool: ToolName;
  target: string;
  project: string | null;
  capabilities: string[];
  coreCommands: string[];
  teamSkills: string[];
  prompts: string[];
  externalSkills: string[];
  workflows: string[];
  projections: MaterializeProjection[];
  mcpServers: string[];
  mcpEntries: ManagedMcpEntry[];
  toolConfig: MaterializeToolConfig;
  sourceFingerprints: MaterializeSourceFingerprints;
};

const digestPattern = /^[a-f0-9]{64}$/u;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;
const safeTarget = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const managedName = /^saber--[a-z0-9][a-z0-9._-]*$/u;
const projectionKinds = new Set<ProjectionKind>([
  "core-command",
  "team-skill",
  "personal-prompt",
  "workflow",
  "external-skill",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.startsWith("\\") && !value.split(/[\\/]+/u).includes("..");
}

function isProjection(value: unknown): value is MaterializeProjection {
  return isRecord(value)
    && exactKeys(value, ["name", "kind", "linkPath", "sourcePath", "sourceDigest", "linkTarget"])
    && typeof value.name === "string"
    && managedName.test(value.name)
    && typeof value.kind === "string"
    && projectionKinds.has(value.kind as ProjectionKind)
    && safeRelativePath(value.linkPath)
    && safeRelativePath(value.sourcePath)
    && (value.sourceDigest === null || (typeof value.sourceDigest === "string" && digestPattern.test(value.sourceDigest)))
    && typeof value.linkTarget === "string"
    && value.linkTarget.length > 0;
}

function isMcpEntry(value: unknown): value is ManagedMcpEntry {
  return isRecord(value)
    && exactKeys(value, ["id", "value", "digest"])
    && typeof value.id === "string"
    && managedName.test(value.id)
    && typeof value.digest === "string"
    && digestPattern.test(value.digest);
}

function isToolConfig(value: unknown): value is MaterializeToolConfig {
  return isRecord(value)
    && exactKeys(value, ["path", "existedBefore", "createdBySaber", "digest"])
    && safeRelativePath(value.path)
    && typeof value.existedBefore === "boolean"
    && typeof value.createdBySaber === "boolean"
    && (value.digest === null || (typeof value.digest === "string" && digestPattern.test(value.digest)));
}

function isSourceFingerprints(value: unknown): value is MaterializeSourceFingerprints {
  return isRecord(value)
    && exactKeys(value, ["team", "local", "external"])
    && typeof value.team === "string"
    && fingerprintPattern.test(value.team)
    && (value.local === null || (typeof value.local === "string" && fingerprintPattern.test(value.local)))
    && (value.external === null || (typeof value.external === "string" && fingerprintPattern.test(value.external)));
}

export function parseRuntimeManifest(text: string): RuntimeManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SaberError("materialize manifest is invalid", 2);
  }
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "managedBy", "tool", "target", "project", "capabilities", "coreCommands",
    "teamSkills", "prompts", "externalSkills", "workflows", "projections", "mcpServers", "mcpEntries",
    "toolConfig", "sourceFingerprints",
  ]) || value.schemaVersion !== 4 || value.managedBy !== "saber"
    || !["codex", "claude", "opencode"].includes(String(value.tool))
    || typeof value.target !== "string" || !safeTarget.test(value.target)
    || (value.project !== null && typeof value.project !== "string")
    || !stringArray(value.capabilities) || !stringArray(value.coreCommands) || !stringArray(value.teamSkills)
    || !stringArray(value.prompts) || !stringArray(value.externalSkills) || !stringArray(value.workflows)
    || !Array.isArray(value.projections) || !value.projections.every(isProjection)
    || !stringArray(value.mcpServers) || !Array.isArray(value.mcpEntries) || !value.mcpEntries.every(isMcpEntry)
    || !isToolConfig(value.toolConfig) || !isSourceFingerprints(value.sourceFingerprints)) {
    throw new SaberError("materialize manifest is not managed by Saber", 2);
  }
  const manifest = value as RuntimeManifest;
  const uniqueLists = [
    manifest.capabilities, manifest.coreCommands, manifest.teamSkills, manifest.prompts,
    manifest.externalSkills, manifest.workflows, manifest.mcpServers,
    manifest.projections.map(({ linkPath }) => linkPath), manifest.mcpEntries.map(({ id }) => id),
  ];
  if (uniqueLists.some((items) => !unique(items))) throw new SaberError("materialize manifest contains duplicate entries", 2);
  try { validateManagedEntries(manifest.mcpEntries); } catch { throw new SaberError("materialize manifest contains invalid MCP entries", 2); }
  if (manifest.mcpServers.length !== manifest.mcpEntries.length
    || !manifest.mcpServers.every((id, index) => manifest.mcpEntries[index]?.id === `saber--${id}`)) {
    throw new SaberError("materialize manifest contains inconsistent MCP entries", 2);
  }
  return manifest;
}

export async function readRuntimeManifestFile(path: string): Promise<RuntimeManifest> {
  return parseRuntimeManifest(await readFile(path, "utf8"));
}
