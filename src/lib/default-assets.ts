import { readFile } from "node:fs/promises";
import { getAsset, isSea } from "node:sea";

import { SaberError } from "./errors.js";

/** Assets that a release binary may safely materialize into an empty team workspace. */
export const defaultAssetPaths = [
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "saber.local.example.yaml",
  "saber.yaml",
  "templates/workitem/workitem.md",
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

export type DefaultAssetPath = (typeof defaultAssetPaths)[number];

const allowed = new Set<string>(defaultAssetPaths);

function sourceUrl(path: DefaultAssetPath): URL {
  return new URL(`../../${path}`, import.meta.url);
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
