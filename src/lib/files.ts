import { readFile, realpath } from "node:fs/promises";
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

/**
 * Resolve an existing file through symlinks and require its canonical target to
 * remain below the canonical repository root. Callers that create new files use
 * resolveWithinRoot instead because a non-existent target cannot be realpath'd.
 */
export async function resolveExistingPathWithinRoot(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  const candidate = resolveWithinRoot(repositoryRoot, relativePath);
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(repositoryRoot),
    realpath(candidate),
  ]);

  if (isOutsideRoot(canonicalRoot, canonicalCandidate)) {
    throw new SaberError(`path escapes repository root: ${relativePath}`);
  }

  return canonicalCandidate;
}

export async function readTextWithinRoot(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  return readFile(await resolveExistingPathWithinRoot(repositoryRoot, relativePath), "utf8");
}
