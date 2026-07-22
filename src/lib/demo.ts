import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SaberError } from "./errors.js";
import { resolveWithinRoot } from "./files.js";

export const demoWorkitemKey = "DEMO-101";

export type DemoResult = {
  key: typeof demoWorkitemKey;
  path: string;
};

type ReservedDirectory = {
  path: string;
  relativePath: string;
  device: number;
  inode: number;
};

const templateRoot = fileURLToPath(
  new URL(`../../templates/demo/${demoWorkitemKey}/`, import.meta.url),
);

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function resolveDemoPath(repositoryRoot: string, relativePath: string): string {
  try {
    return resolveWithinRoot(repositoryRoot, relativePath);
  } catch (error: unknown) {
    if (error instanceof SaberError) throw new SaberError(error.message, 2);
    throw error;
  }
}

async function assertReservedDirectory(
  repositoryRoot: string,
  reserved: ReservedDirectory,
): Promise<void> {
  if (resolveDemoPath(repositoryRoot, reserved.relativePath) !== reserved.path) {
    throw new SaberError("demo destination changed during copy", 1);
  }
  const status = await lstat(reserved.path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.dev !== reserved.device ||
    status.ino !== reserved.inode
  ) {
    throw new SaberError("demo destination changed during copy", 1);
  }
}

async function removeReservedDirectory(
  repositoryRoot: string,
  reserved: ReservedDirectory,
): Promise<void> {
  try {
    await assertReservedDirectory(repositoryRoot, reserved);
    await rm(reserved.path, { recursive: true, force: true });
  } catch {
    // A changed path is not owned by this invocation and must never be removed.
  }
}

/**
 * Copy the bundled starter once, rejecting untrusted workspace symlinks and
 * detectable path drift. A hostile process with the same OS account is outside
 * this boundary because Node has no cross-platform openat-style filesystem API.
 */
export async function createDemoWorkitem(
  repositoryRoot: string,
  key = demoWorkitemKey,
): Promise<DemoResult> {
  if (key !== demoWorkitemKey) {
    throw new SaberError(`unsupported demo ${key}; only ${demoWorkitemKey} is available`, 2);
  }

  const lexicalWorkitemsPath = join(repositoryRoot, "workitems");
  let workitemsPath: string;
  try {
    const status = await lstat(lexicalWorkitemsPath);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new SaberError("workitems must be a regular directory", 2);
    }
    workitemsPath = resolveDemoPath(repositoryRoot, "workitems");
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    workitemsPath = resolveDemoPath(repositoryRoot, "workitems");
    await mkdir(workitemsPath);
  }

  const relativeTarget = `workitems/${demoWorkitemKey}`;
  const target = resolveDemoPath(repositoryRoot, relativeTarget);
  let reserved: ReservedDirectory;
  try {
    await mkdir(target);
    const status = await lstat(target);
    reserved = {
      path: target,
      relativePath: relativeTarget,
      device: status.dev,
      inode: status.ino,
    };
    await assertReservedDirectory(repositoryRoot, reserved);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new SaberError(`workitem ${demoWorkitemKey} already exists; refusing to overwrite it`, 2);
    }
    throw new SaberError("could not create demo workitem", 1);
  }

  try {
    for (const entry of await readdir(templateRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new SaberError("demo template contains an unsupported symbolic link", 1);
      }
      await assertReservedDirectory(repositoryRoot, reserved);
      await cp(join(templateRoot, entry.name), join(target, entry.name), {
        recursive: entry.isDirectory(),
        force: false,
        errorOnExist: true,
      });
      await assertReservedDirectory(repositoryRoot, reserved);
    }
    await assertReservedDirectory(repositoryRoot, reserved);
    return { key: demoWorkitemKey, path: relativeTarget };
  } catch (error: unknown) {
    await removeReservedDirectory(repositoryRoot, reserved);
    if (error instanceof SaberError) throw error;
    throw new SaberError("could not copy demo workitem", 1);
  }
}
