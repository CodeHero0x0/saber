import { SaberError } from "../errors.js";
import {
  assertNoOwnershipConflicts,
  assertSnapshotFormat,
  assertUniqueMcpObjectKeys,
  isRecord,
  verifyManagedEntries,
  type ManagedMcpEntry,
  type ToolConfigAdapter,
  type ToolConfigSnapshot,
} from "./types.js";

export const claudeToolConfig: ToolConfigAdapter = {
  relativePath: ".mcp.json",

  inspect(text: string | undefined): ToolConfigSnapshot {
    let parsed: unknown = {};
    if (text !== undefined && text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SaberError("invalid Claude configuration");
      }
    }
    if (text !== undefined && text.trim() !== "") {
      assertUniqueMcpObjectKeys(text, "claude", "mcpServers");
    }
    if (!isRecord(parsed)) {
      throw new SaberError("invalid Claude configuration: root must be an object");
    }
    const entries = parsed.mcpServers ?? {};
    if (!isRecord(entries)) {
      throw new SaberError("invalid Claude configuration: mcpServers must be an object");
    }
    return { format: "claude", text, config: parsed, entries };
  },

  render(snapshot: ToolConfigSnapshot, desired: ManagedMcpEntry[]): string {
    assertSnapshotFormat(snapshot, "claude");
    assertNoOwnershipConflicts(snapshot, desired);
    const config = { ...snapshot.config };
    const entries = { ...snapshot.entries };
    for (const entry of desired) {
      entries[entry.id] = entry.value;
    }
    config.mcpServers = entries;
    const rendered = `${JSON.stringify(config, null, 2)}\n`;
    verifyManagedEntries(claudeToolConfig.inspect(rendered), desired);
    return rendered;
  },

  verify(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): void {
    assertSnapshotFormat(snapshot, "claude");
    verifyManagedEntries(snapshot, managed);
  },

  remove(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): string | null {
    assertSnapshotFormat(snapshot, "claude");
    verifyManagedEntries(snapshot, managed);
    const config = { ...snapshot.config };
    const entries = { ...snapshot.entries };
    for (const entry of managed) {
      delete entries[entry.id];
    }
    if (Object.keys(entries).length === 0) {
      delete config.mcpServers;
    } else {
      config.mcpServers = entries;
    }
    if (Object.keys(config).length === 0) {
      return null;
    }
    const rendered = `${JSON.stringify(config, null, 2)}\n`;
    const updated = claudeToolConfig.inspect(rendered);
    for (const entry of managed) {
      if (Object.hasOwn(updated.entries, entry.id)) {
        throw new SaberError(`managed MCP entry ${entry.id} was not removed`);
      }
    }
    return rendered;
  },
};
