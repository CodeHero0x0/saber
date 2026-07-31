import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SaberError } from "./errors.js";

export type UpstreamSkillSyncResult = {
  cacheDirectory: string;
  skills: string[];
};

export type UpstreamSkillSynchronizer = (
  root: string,
  source: string,
  skillIds: readonly string[],
) => Promise<UpstreamSkillSyncResult>;

async function runGitClone(source: string, destination: string, cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["clone", "--depth", "1", "--branch", "main", source, destination], {
      cwd,
      stdio: "ignore",
    });
    child.once("error", () => rejectPromise(new SaberError("could not start git while updating upstream skills", 1)));
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new SaberError("could not update upstream skills from main", 1));
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

/** Clone the current upstream main branch, then retain only the configured skill folders. */
export const syncUpstreamSkills: UpstreamSkillSynchronizer = async (root, source, skillIds) => {
  const managedRoot = join(root, ".saber", "managed");
  const cacheDirectory = join(managedRoot, "skills");
  const temporaryDirectory = join(managedRoot, `.upstream-${randomUUID()}`);
  const checkoutDirectory = join(temporaryDirectory, "source");

  await mkdir(managedRoot, { recursive: true });
  if (skillIds.length === 0) {
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(managedRoot, "manifest.json"), `${JSON.stringify({ source, skills: [] }, null, 2)}\n`, "utf8");
    return { cacheDirectory, skills: [] };
  }

  try {
    await runGitClone(source, checkoutDirectory, root);
    const catalog = await discoverSkillDirectories(join(checkoutDirectory, "skills"));
    const selected = skillIds.map((id) => {
      const matches = catalog.get(id) ?? [];
      if (matches.length !== 1) {
        throw new SaberError(`upstream main does not contain one unambiguous skill named ${id}`, 2);
      }
      return { id, directory: matches[0]! };
    });

    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(cacheDirectory, { recursive: true });
    for (const skill of selected) await cp(skill.directory, join(cacheDirectory, skill.id), { recursive: true });
    await writeFile(
      join(managedRoot, "manifest.json"),
      `${JSON.stringify({ source, skills: skillIds }, null, 2)}\n`,
      "utf8",
    );
    return { cacheDirectory, skills: [...skillIds] };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
