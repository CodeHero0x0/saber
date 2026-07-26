import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { SaberError } from "./errors.js";
import { gitCommand, runSafeProcess } from "./git.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

async function hasGitMetadata(root: string): Promise<boolean> {
  try {
    await lstat(join(root, ".git"));
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Refuse to place local credentials in a configuration file Git already tracks. */
export async function assertUntrackedRuntimeConfig(root: string, path: string): Promise<void> {
  const repository = await runSafeProcess(gitCommand(["rev-parse", "--is-inside-work-tree"], root));
  if (repository.exitCode !== 0) {
    if (await hasGitMetadata(root)) {
      throw new SaberError("could not verify Git tracking for tool configuration", 2);
    }
    return;
  }
  const tracked = await runSafeProcess(gitCommand(["ls-files", "--error-unmatch", "--", path], root));
  if (tracked.exitCode === 0) {
    throw new SaberError("refuses to write credentials into a Git-tracked tool configuration", 2);
  }
  if (tracked.exitCode !== 1) {
    throw new SaberError("could not verify Git tracking for tool configuration", 2);
  }
}
