import { applyEdits, modify, parse, printParseErrorCode, visit, type ParseError } from "jsonc-parser";

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

const formattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
  insertFinalNewline: true,
} as const;

export const opencodeToolConfig: ToolConfigAdapter = {
  relativePath: "opencode.json",

  inspect(text: string | undefined): ToolConfigSnapshot {
    const source = text === undefined || text.trim() === "" ? "{}" : text;
    const errors: ParseError[] = [];
    const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const error = errors[0];
      throw new SaberError(
        `invalid OpenCode configuration at offset ${error.offset}: ${printParseErrorCode(error.error)}`,
      );
    }
    assertUniqueMcpObjectKeys(source, "opencode", "mcp");
    if (!isRecord(parsed)) {
      throw new SaberError("invalid OpenCode configuration: root must be an object");
    }
    const entries = parsed.mcp ?? {};
    if (!isRecord(entries)) {
      throw new SaberError("invalid OpenCode configuration: mcp must be an object");
    }
    return { format: "opencode", text, config: parsed, entries };
  },

  render(snapshot: ToolConfigSnapshot, desired: ManagedMcpEntry[]): string {
    assertSnapshotFormat(snapshot, "opencode");
    assertNoOwnershipConflicts(snapshot, desired);
    let text = usableSource(snapshot.text);
    for (const entry of desired) {
      text = edit(text, ["mcp", entry.id], entry.value);
    }
    const updated = opencodeToolConfig.inspect(text);
    verifyManagedEntries(updated, desired);
    return text;
  },

  verify(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): void {
    assertSnapshotFormat(snapshot, "opencode");
    verifyManagedEntries(snapshot, managed);
  },

  remove(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): string | null {
    assertSnapshotFormat(snapshot, "opencode");
    verifyManagedEntries(snapshot, managed);
    let text = usableSource(snapshot.text);
    for (const entry of managed) {
      const withoutEntry = edit(text, ["mcp", entry.id], undefined);
      if (!sameComments(text, withoutEntry)) {
        throw new SaberError(`cannot remove managed MCP entry ${entry.id} without losing a user comment`);
      }
      text = withoutEntry;
    }
    let updated = opencodeToolConfig.inspect(text);
    if (Object.keys(updated.entries).length === 0) {
      const withoutContainer = edit(text, ["mcp"], undefined);
      if (sameComments(text, withoutContainer)) {
        text = withoutContainer;
        updated = opencodeToolConfig.inspect(text);
      }
    }
    if (Object.keys(updated.config).length === 0 && comments(text).length === 0) {
      return null;
    }
    for (const entry of managed) {
      if (Object.hasOwn(updated.entries, entry.id)) {
        throw new SaberError(`managed MCP entry ${entry.id} was not removed`);
      }
    }
    return text;
  },
};

function usableSource(text: string | undefined): string {
  return text === undefined || text.trim() === "" ? "{}\n" : text;
}

function edit(text: string, path: string[], value: unknown): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions }));
}

function sameComments(before: string, after: string): boolean {
  const beforeComments = comments(before);
  const afterComments = comments(after);
  return beforeComments.length === afterComments.length
    && beforeComments.every((comment, index) => comment === afterComments[index]);
}

function comments(text: string): string[] {
  const found: string[] = [];
  visit(text, {
    onComment(offset, length) {
      found.push(text.slice(offset, offset + length));
    },
  });
  return found;
}
