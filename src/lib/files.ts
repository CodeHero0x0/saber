import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { SaberError } from "./errors.js";

function isOutsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  );
}

function isPlatformAbsolutePath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}

/**
 * Resolve a repository-owned path while refusing absolute paths and traversal
 * that would make a command read or write outside the selected Saber checkout.
 */
export function resolveWithinRoot(repositoryRoot: string, relativePath: string): string {
  if (isPlatformAbsolutePath(relativePath)) {
    throw new SaberError(`path escapes repository root: ${relativePath}`);
  }

  const root = resolve(repositoryRoot);
  const candidate = resolve(root, relativePath);

  if (isOutsideRoot(root, candidate)) {
    throw new SaberError(`path escapes repository root: ${relativePath}`);
  }

  return candidate;
}

export async function readTextWithinRoot(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  return readFile(resolveWithinRoot(repositoryRoot, relativePath), "utf8");
}
