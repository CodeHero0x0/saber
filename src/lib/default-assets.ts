import { readFile } from "node:fs/promises";
import { getAsset, isSea } from "node:sea";

import { SaberError } from "./errors.js";

/** Assets that a release binary may safely materialize into an empty team workspace. */
export const workspaceDefaultAssetPaths = [
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "saber.local.example.yaml",
  "saber.yaml",
  "templates/workitem/workitem.md",
] as const;

/** Saber-owned skills are materialized below .saber/runtime, never into the team-owned skills/ directory. */
export const builtinSkillAssetPaths = [
  "skills/grill-me/SKILL.md",
  "skills/grill-with-docs/SKILL.md",
  "skills/openspec/SKILL.md",
  "skills/saber/SKILL.md",
  "skills/saber-grill/SKILL.md",
  "skills/saber-grill-with-docs/SKILL.md",
  "skills/saber-openspec/SKILL.md",
  "skills/saber-superpower/SKILL.md",
  "skills/superpowers/SKILL.md",
] as const;

/** All packaged assets needed by either workspace scaffolding or the managed built-in runtime. */
export const defaultAssetPaths = [...workspaceDefaultAssetPaths, ...builtinSkillAssetPaths] as const;

export type DefaultAssetPath = (typeof defaultAssetPaths)[number];

const allowed = new Set<string>(defaultAssetPaths);

function sourcePath(path: DefaultAssetPath): string {
  // npm renames a packaged root .gitignore to .npmignore. Keep the runtime template
  // under a neutral filename so installed packages can still scaffold .gitignore.
  return path === ".gitignore" ? "templates/default.gitignore" : path;
}

function sourceUrl(path: DefaultAssetPath): URL {
  return new URL(`../../${sourcePath(path)}`, import.meta.url);
}

/** Read the Saber package version embedded in an executable or installed package. */
export async function readSaberVersion(): Promise<string> {
  try {
    const text = isSea()
      ? getAsset("package.json", "utf8")
      : await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u).test(String((value as { version?: unknown }).version))) {
      throw new Error();
    }
    return (value as { version: string }).version;
  } catch {
    throw new SaberError("could not determine Saber runtime version", 1);
  }
}

/** Read a whitelisted release asset from a SEA executable or from the source checkout. */
export async function readDefaultAsset(path: DefaultAssetPath): Promise<string> {
  if (!allowed.has(path)) throw new SaberError("unknown default runtime asset", 1);
  if (isSea()) {
    try {
      return getAsset(path, "utf8");
    } catch {
      throw new SaberError("release binary is missing a default runtime asset", 1);
    }
  }
  try {
    return await readFile(sourceUrl(path), "utf8");
  } catch {
    throw new SaberError("could not load a default runtime asset", 1);
  }
}
