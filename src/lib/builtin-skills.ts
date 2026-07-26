import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  builtinSkillAssetPaths,
  readDefaultAsset,
  readSaberVersion,
} from "./default-assets.js";
import { SaberError } from "./errors.js";
import { resolveWithinRoot } from "./files.js";

const manifestPath = ".saber/runtime/builtin-skills/manifest.json";
const schemaVersion = 1;

export const builtinSkillIds = builtinSkillAssetPaths.map((path) => path.slice("skills/".length, -"/SKILL.md".length));

export type BuiltinSkillsResult = {
  version: string;
  rootPath: string;
};

type BuiltinSkillsManifest = {
  schemaVersion: 1;
  managedBy: "saber";
  version: string;
  rootPath: string;
  skills: Record<string, string>;
};

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function runtimeRoot(version: string): string {
  return `.saber/runtime/builtin-skills/${version}/skills`;
}

async function readManifest(root: string): Promise<BuiltinSkillsManifest | undefined> {
  const path = resolveWithinRoot(root, manifestPath);
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const manifest = value as Partial<BuiltinSkillsManifest>;
    if (manifest.schemaVersion !== schemaVersion || manifest.managedBy !== "saber" || typeof manifest.version !== "string"
      || typeof manifest.rootPath !== "string" || typeof manifest.skills !== "object" || manifest.skills === null || Array.isArray(manifest.skills)) throw new Error();
    return manifest as BuiltinSkillsManifest;
  } catch {
    throw new SaberError("built-in skill manifest is invalid", 2);
  }
}

async function readExpected(): Promise<Array<{ id: string; content: string; digest: string }>> {
  return Promise.all(builtinSkillAssetPaths.map(async (path) => {
    const id = path.slice("skills/".length, -"/SKILL.md".length);
    const content = await readDefaultAsset(path);
    return { id, content, digest: digest(content) };
  }));
}

async function assertSafeFile(path: string, label: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new SaberError(`managed built-in skill is unsafe: ${label}`, 2);
}

/**
 * Install one immutable set of Saber-owned built-in skills for the running version.
 * Existing bytes are never overwritten: a local modification becomes an explicit conflict.
 */
export async function ensureBuiltinSkills(root: string): Promise<BuiltinSkillsResult> {
  const version = await readSaberVersion();
  const rootPath = runtimeRoot(version);
  const expected = await readExpected();
  const previous = await readManifest(root);

  if (previous?.version === version) {
    for (const skill of expected) {
      const path = resolveWithinRoot(root, `${rootPath}/${skill.id}/SKILL.md`);
      try {
        await assertSafeFile(path, skill.id);
        if (digest(await readFile(path, "utf8")) !== skill.digest) {
          throw new SaberError(`managed built-in skill was modified: ${skill.id}; resolve the conflict before rerunning Saber`, 2);
        }
      } catch (error: unknown) {
        if (error instanceof SaberError) throw error;
        throw new SaberError(`managed built-in skill is missing: ${skill.id}; resolve the conflict before rerunning Saber`, 2);
      }
    }
    return { version, rootPath };
  }

  for (const skill of expected) {
    const path = resolveWithinRoot(root, `${rootPath}/${skill.id}/SKILL.md`);
    try {
      await assertSafeFile(path, skill.id);
      if (digest(await readFile(path, "utf8")) !== skill.digest) {
        throw new SaberError(`managed built-in skill conflicts with Saber ${version}: ${skill.id}`, 2);
      }
    } catch (error: unknown) {
      if (error instanceof SaberError) throw error;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, skill.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }

  const manifest: BuiltinSkillsManifest = {
    schemaVersion,
    managedBy: "saber",
    version,
    rootPath,
    skills: Object.fromEntries(expected.map((skill) => [skill.id, skill.digest])),
  };
  const destination = resolveWithinRoot(root, manifestPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { version, rootPath };
}
