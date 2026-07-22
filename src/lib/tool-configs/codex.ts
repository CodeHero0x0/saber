import { parse, stringify } from "smol-toml";

import { SaberError } from "../errors.js";
import {
  assertNoOwnershipConflicts,
  assertSnapshotFormat,
  isRecord,
  normalizedMcpValue,
  verifyManagedEntries,
  type ManagedMcpEntry,
  type ToolConfigAdapter,
  type ToolConfigSnapshot,
} from "./types.js";

export const codexToolConfig: ToolConfigAdapter = {
  relativePath: ".codex/config.toml",

  inspect(text: string | undefined): ToolConfigSnapshot {
    let parsed: unknown = {};
    if (text !== undefined && text.trim() !== "") {
      try {
        parsed = parse(text);
      } catch {
        throw invalidCodexConfiguration();
      }
    }
    if (!isRecord(parsed)) {
      throw new SaberError("invalid Codex configuration: root must be a table");
    }
    if (
      text !== undefined
      && Object.hasOwn(parsed, "mcp_servers")
      && hasRootInlineMcpServers(text)
    ) {
      throw new SaberError("invalid Codex configuration: inline mcp_servers is not supported");
    }
    const entries = parsed.mcp_servers ?? {};
    if (!isRecord(entries)) {
      throw new SaberError("invalid Codex configuration: mcp_servers must be a table");
    }
    return { format: "codex", text, config: parsed, entries };
  },

  render(snapshot: ToolConfigSnapshot, desired: ManagedMcpEntry[]): string {
    assertSnapshotFormat(snapshot, "codex");
    assertNoOwnershipConflicts(snapshot, desired);
    let rendered = snapshot.text ?? "";
    for (const entry of desired) {
      rendered += `${rendered.length === 0 ? "" : "\n"}${managedBlock(entry)}`;
    }
    const updated = codexToolConfig.inspect(rendered);
    verifyCodexEntries(updated, desired);
    return rendered;
  },

  verify(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): void {
    assertSnapshotFormat(snapshot, "codex");
    verifyCodexEntries(snapshot, managed);
  },

  remove(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): string | null {
    assertSnapshotFormat(snapshot, "codex");
    verifyCodexEntries(snapshot, managed);
    let rendered = snapshot.text ?? "";
    for (const entry of managed) {
      rendered = removeManagedBlock(rendered, entry);
    }
    if (rendered === "") {
      return null;
    }
    const updated = codexToolConfig.inspect(rendered);
    for (const entry of managed) {
      if (Object.hasOwn(updated.entries, entry.id)) {
        throw new SaberError(`managed MCP entry ${entry.id} was not removed`);
      }
    }
    return rendered;
  },
};

function verifyCodexEntries(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): void {
  verifyManagedEntries(snapshot, managed);
  const text = snapshot.text ?? "";
  for (const entry of managed) {
    if (managedBlockOccurrences(text, entry) !== 1) {
      throw new SaberError(`managed MCP entry ${entry.id} has no exact managed block`);
    }
  }
}

function managedBlock(entry: ManagedMcpEntry): string {
  let body: string;
  try {
    const canonicalValue = JSON.parse(normalizedMcpValue(entry.value)) as unknown;
    body = stringify({ mcp_servers: { [entry.id]: canonicalValue } });
  } catch {
    throw invalidCodexConfiguration();
  }
  const begin = `# saber-managed-mcp-begin id=${entry.id} digest=${entry.digest}`;
  const end = `# saber-managed-mcp-end id=${entry.id}`;
  return `${begin}\n${body}${body.endsWith("\n") ? "" : "\n"}${end}\n`;
}

function managedBlockOccurrences(text: string, entry: ManagedMcpEntry): number {
  const block = managedBlock(entry);
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(block, offset)) >= 0) {
    count += 1;
    offset += block.length;
  }
  return count;
}

function removeManagedBlock(text: string, entry: ManagedMcpEntry): string {
  const block = managedBlock(entry);
  const prefixed = `\n${block}`;
  const prefixedAt = text.indexOf(prefixed);
  if (prefixedAt >= 0 && text.indexOf(prefixed, prefixedAt + prefixed.length) < 0) {
    return text.slice(0, prefixedAt) + text.slice(prefixedAt + prefixed.length);
  }
  if (text.startsWith(block) && text.indexOf(block, block.length) < 0) {
    return text.slice(block.length);
  }
  throw new SaberError(`managed MCP entry ${entry.id} has no exact managed block`);
}

function invalidCodexConfiguration(): SaberError {
  return new SaberError("invalid Codex configuration");
}

function hasRootInlineMcpServers(text: string): boolean {
  let multilineDelimiter: '"""' | "'''" | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    if (multilineDelimiter !== undefined) {
      const closing = rawLine.indexOf(multilineDelimiter);
      if (closing >= 0) {
        multilineDelimiter = undefined;
      }
      continue;
    }
    const line = rawLine.replace(/^\uFEFF/u, "");
    if (/^[ \t]*\[/u.test(line)) {
      return false;
    }
    if (/^[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*=/u.test(line)) {
      return true;
    }
    multilineDelimiter = openedMultilineString(line);
  }
  return false;
}

function openedMultilineString(line: string): '"""' | "'''" | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    if (quote !== undefined) {
      if (quote === '"' && line[index] === "\\") {
        index += 1;
      } else if (line[index] === quote) {
        quote = undefined;
      }
      continue;
    }
    if (line[index] === "#") {
      return undefined;
    }
    const candidate = line.slice(index, index + 3);
    if (candidate === '"""' || candidate === "'''") {
      const closing = line.indexOf(candidate, index + 3);
      if (closing < 0) {
        return candidate;
      }
      index = closing + 2;
    } else if (line[index] === '"' || line[index] === "'") {
      quote = line[index] as '"' | "'";
    }
  }
  return undefined;
}
