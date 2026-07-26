import { createHash } from "node:crypto";
import { visit } from "jsonc-parser";

import { SaberError } from "../errors.js";

export type ManagedMcpEntry = { id: string; value: unknown; digest: string };

export type ToolConfigFormat = "codex" | "claude" | "opencode";

export type ToolConfigSnapshot = {
  readonly format: ToolConfigFormat;
  readonly text: string | undefined;
  readonly config: Record<string, unknown>;
  readonly entries: Record<string, unknown>;
};

export interface ToolConfigAdapter {
  readonly relativePath: string;
  inspect(text: string | undefined): ToolConfigSnapshot;
  /** Adds only absent names. To update, first verify and remove the old manifest entries. */
  render(snapshot: ToolConfigSnapshot, desired: ManagedMcpEntry[]): string;
  verify(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): void;
  /** Removes only entries whose value and digest still match the old manifest. */
  remove(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): string | null;
}

const managedIdPattern = /^saber--[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export function createManagedMcpEntry(id: string, value: unknown): ManagedMcpEntry {
  assertManagedMcpId(id);
  return { id, value, digest: digestMcpValue(value) };
}

export function digestMcpValue(value: unknown): string {
  return createHash("sha256").update(normalizedMcpValue(value)).digest("hex");
}

export function normalizedMcpValue(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function validateManagedEntries(entries: ManagedMcpEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    assertManagedMcpId(entry.id);
    if (ids.has(entry.id)) {
      throw new SaberError(`duplicate managed MCP entry ${entry.id}`);
    }
    ids.add(entry.id);
    const actualDigest = digestMcpValue(entry.value);
    if (entry.digest !== actualDigest) {
      throw new SaberError(`managed MCP entry ${entry.id} has an invalid digest`);
    }
  }
}

export function verifyManagedEntries(
  snapshot: ToolConfigSnapshot,
  managed: ManagedMcpEntry[],
): void {
  validateManagedEntries(managed);
  for (const entry of managed) {
    if (!Object.hasOwn(snapshot.entries, entry.id)) {
      throw new SaberError(`managed MCP entry ${entry.id} is missing`);
    }
    const actual = snapshot.entries[entry.id];
    if (
      digestMcpValue(actual) !== entry.digest
      || normalizedMcpValue(actual) !== normalizedMcpValue(entry.value)
    ) {
      throw new SaberError(`managed MCP entry ${entry.id} does not match its manifest`);
    }
  }
}

export function assertSnapshotFormat(snapshot: ToolConfigSnapshot, format: ToolConfigFormat): void {
  if (snapshot.format !== format) {
    throw new SaberError(`expected a ${format} tool configuration snapshot`);
  }
}

export function assertNoOwnershipConflicts(
  snapshot: ToolConfigSnapshot,
  desired: ManagedMcpEntry[],
): void {
  validateManagedEntries(desired);
  for (const entry of desired) {
    if (Object.hasOwn(snapshot.entries, entry.id)) {
      throw new SaberError(`MCP ownership conflict for ${entry.id}`);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertUniqueMcpObjectKeys(
  text: string,
  format: ToolConfigFormat,
  containerKey: string,
): void {
  let containerCount = 0;
  const entryKeys = new Set<string>();
  let duplicateEntry: string | undefined;
  visit(text, {
    onObjectProperty(property, _offset, _length, _startLine, _startCharacter, pathSupplier) {
      const path = pathSupplier();
      if (path.length === 0 && property === containerKey) {
        containerCount += 1;
      } else if (path.length === 1 && path[0] === containerKey) {
        if (entryKeys.has(property)) {
          duplicateEntry = property;
        }
        entryKeys.add(property);
      }
    },
  });
  if (containerCount > 1) {
    throw new SaberError(`invalid ${format} configuration: duplicate ${containerKey} container`);
  }
  if (duplicateEntry !== undefined) {
    throw new SaberError(`invalid ${format} configuration: duplicate MCP entry key`);
  }
}

function assertManagedMcpId(id: string): void {
  if (!managedIdPattern.test(id)) {
    throw new SaberError(`managed MCP entry id must use the saber-- namespace: ${id}`);
  }
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SaberError("MCP entry contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SaberError("MCP entry contains an object with an unsupported prototype");
    }
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalize(value[key]);
    }
    return normalized;
  }
  throw new SaberError("MCP entry must contain only structured configuration values");
}
