import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SaberError } from "./errors.js";
import type { SaberSkillSource } from "./types.js";

export type UpstreamSkillSyncResult = {
  cacheDirectory: string;
  skills: string[];
};

export type UpstreamSkillSynchronizer = (
  root: string,
  sources: readonly SaberSkillSource[],
) => Promise<UpstreamSkillSyncResult>;

async function runGitClone(source: SaberSkillSource, destination: string, cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["clone", "--depth", "1", "--branch", source.ref, source.repository, destination], {
      cwd,
      stdio: "ignore",
    });
    child.once("error", () => rejectPromise(new SaberError("could not start git while updating upstream skills", 1)));
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new SaberError(`could not update skill source ${source.id} at ${source.ref}`, 1));
    });
  });
}

async function discoverSkillDirectories(root: string, found = new Map<string, string[]>()): Promise<Map<string, string[]>> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const skillFile = join(directory, "SKILL.md");
    const hasSkill = await stat(skillFile).then((status) => status.isFile()).catch(() => false);
    if (hasSkill) {
      const matches = found.get(entry.name) ?? [];
      matches.push(directory);
      found.set(entry.name, matches);
    }
    await discoverSkillDirectories(directory, found);
  }
  return found;
}

/** Clone each configured source, then retain only an unambiguous, collision-free skill set. */
export const syncUpstreamSkills: UpstreamSkillSynchronizer = async (root, sources) => {
  const managedRoot = join(root, ".saber", "managed");
  const cacheDirectory = join(managedRoot, "skills");
  const temporaryDirectory = join(managedRoot, `.upstream-${randomUUID()}`);
  const stagedCache = join(temporaryDirectory, "skills");
  const skillIds = sources.flatMap(({ include }) => include);

  await mkdir(managedRoot, { recursive: true });
  if (skillIds.length === 0) {
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(managedRoot, "manifest.json"), `${JSON.stringify({ sources: [], skills: [] }, null, 2)}\n`, "utf8");
    return { cacheDirectory, skills: [] };
  }

  try {
    await mkdir(stagedCache, { recursive: true });
    const selected = new Map<string, { source: SaberSkillSource; directory: string }>();
    for (const source of sources) {
      const checkoutDirectory = join(temporaryDirectory, source.id);
      await runGitClone(source, checkoutDirectory, root);
      const catalog = await discoverSkillDirectories(join(checkoutDirectory, "skills"));
      for (const id of source.include) {
        const matches = catalog.get(id) ?? [];
        if (matches.length !== 1) {
          throw new SaberError(`skill source ${source.id} at ${source.ref} does not contain one unambiguous skill named ${id}`, 2);
        }
        if (selected.has(id)) throw new SaberError(`skill ${id} is selected from more than one source`, 2);
        selected.set(id, { source, directory: matches[0]! });
      }
    }

    for (const [id, skill] of selected) await cp(skill.directory, join(stagedCache, id), { recursive: true });
    await rm(cacheDirectory, { recursive: true, force: true });
    await cp(stagedCache, cacheDirectory, { recursive: true });
    await writeFile(
      join(managedRoot, "manifest.json"),
      `${JSON.stringify({ sources: sources.map(({ id, repository, ref, include }) => ({ id, repository, ref, include })), skills: skillIds }, null, 2)}\n`,
      "utf8",
    );
    return { cacheDirectory, skills: [...skillIds] };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
