import { lstat } from "node:fs/promises";

import { parse } from "dotenv";

import { SaberError } from "./errors.js";
import { readTextWithinRoot, resolveWithinRoot } from "./files.js";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function readEnvironmentFile(root: string): Promise<Record<string, string>> {
  try {
    const path = resolveWithinRoot(root, ".env");
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("unsafe environment file");
    return parse(await readTextWithinRoot(root, ".env"));
  } catch {
    throw new SaberError("MCP environment is unavailable", 2);
  }
}

/** Read only named, non-empty values from the repository-local .env file. */
export async function loadMcpEnvironment(
  root: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const required = unique(names);
  if (required.length === 0) return {};
  const environment = await readEnvironmentFile(root);
  const missing = required.filter((name) => environment[name] === undefined || environment[name]?.trim() === "");
  if (missing.length > 0) {
    throw new SaberError(`MCP environment is missing: ${missing.join(", ")}`, 2);
  }
  return Object.fromEntries(required.map((name) => [name, environment[name]! ]));
}

/** Check required names without exposing any value to diagnostics. */
export async function missingMcpEnvironment(root: string, names: readonly string[]): Promise<string[]> {
  const required = unique(names);
  if (required.length === 0) return [];
  try {
    const environment = await readEnvironmentFile(root);
    return required.filter((name) => environment[name] === undefined || environment[name]?.trim() === "");
  } catch {
    return required;
  }
}
