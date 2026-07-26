import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { SaberError } from "./errors.js";

type LifecycleLockOwner = {
  schemaVersion: 1;
  managedBy: "saber";
  pid: number;
  nonce: string;
  createdAt: string;
};

const activeRepositories = new Set<string>();

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOwner(text: string): LifecycleLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new SaberError("repository lifecycle lock is invalid", 3);
  }
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "createdAt,managedBy,nonce,pid,schemaVersion"
    || value.schemaVersion !== 1
    || value.managedBy !== "saber"
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.nonce !== "string"
    || value.nonce.length === 0
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new SaberError("repository lifecycle lock is invalid", 3);
  }
  return value as LifecycleLockOwner;
}

function ownerIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ESRCH") return false;
    return true;
  }
}

async function ensureLockParent(repositoryRoot: string): Promise<{
  lockPath: string;
  createdDirectories: string[];
}> {
  const canonicalRoot = await realpath(repositoryRoot);
  const createdDirectories: string[] = [];
  let current = canonicalRoot;
  for (const component of [".saber", "runtime"]) {
    current = join(current, component);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SaberError("repository lifecycle lock path is unsafe", 3);
      }
    } catch (error: unknown) {
      if (error instanceof SaberError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
        createdDirectories.push(current);
      } catch (mkdirError: unknown) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SaberError("repository lifecycle lock path is unsafe", 3);
      }
    }
    const canonical = await realpath(current);
    const fromRoot = relative(canonicalRoot, canonical);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new SaberError("repository lifecycle lock path is unsafe", 3);
    }
  }
  return { lockPath: join(current, "lifecycle.lock"), createdDirectories };
}

async function readExistingOwner(lockPath: string): Promise<LifecycleLockOwner> {
  let status;
  try {
    status = await lstat(lockPath);
  } catch {
    throw new SaberError("repository lifecycle lock is invalid", 3);
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new SaberError("repository lifecycle lock is invalid", 3);
  }
  try {
    return parseOwner(await readFile(lockPath, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SaberError) throw error;
    throw new SaberError("repository lifecycle lock is invalid", 3);
  }
}

async function acquire(lockPath: string, owner: LifecycleLockOwner): Promise<void> {
  for (;;) {
    try {
      await writeFile(lockPath, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const existing = await readExistingOwner(lockPath);
    if (ownerIsActive(existing.pid)) {
      throw new SaberError("repository lifecycle operation is already active", 3);
    }

    const current = await readExistingOwner(lockPath);
    if (current.nonce !== existing.nonce || current.pid !== existing.pid) {
      throw new SaberError("repository lifecycle operation is already active", 3);
    }
    try {
      await unlink(lockPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function release(lockPath: string, owner: LifecycleLockOwner): Promise<void> {
  const current = await readExistingOwner(lockPath);
  if (current.nonce !== owner.nonce || current.pid !== owner.pid) {
    throw new SaberError("repository lifecycle lock ownership changed", 3);
  }
  await unlink(lockPath);
}

async function removeCreatedDirectories(paths: readonly string[]): Promise<void> {
  for (const path of [...paths].reverse()) {
    try {
      await rmdir(path);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") throw error;
    }
  }
}

/** Serialize every repository lifecycle read/recovery/write sequence. */
export async function withRepositoryLifecycleLock<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const canonicalRoot = resolve(await realpath(repositoryRoot));
  if (activeRepositories.has(canonicalRoot)) {
    throw new SaberError("repository lifecycle operation is already active", 3);
  }
  activeRepositories.add(canonicalRoot);

  let acquired = false;
  let lockPath: string | undefined;
  let createdDirectories: string[] = [];
  const owner: LifecycleLockOwner = {
    schemaVersion: 1,
    managedBy: "saber",
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    const prepared = await ensureLockParent(canonicalRoot);
    lockPath = prepared.lockPath;
    createdDirectories = prepared.createdDirectories;
    await acquire(lockPath, owner);
    acquired = true;
    return await operation();
  } finally {
    try {
      if (acquired && lockPath !== undefined) await release(lockPath, owner);
      await removeCreatedDirectories(createdDirectories);
    } finally {
      activeRepositories.delete(canonicalRoot);
    }
  }
}
