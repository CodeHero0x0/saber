import { lstatSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function nearestExistingAncestor(candidate: string): string {
  let ancestor = candidate;

  while (true) {
    try {
      lstatSync(ancestor);
      return ancestor;
    } catch (error: unknown) {
      if (!isMissingPath(error)) {
        throw error;
      }

      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new SaberError(`could not find an existing ancestor for ${candidate}`);
      }
      ancestor = parent;
    }
  }
}

/**
 * Resolve a repository-owned path for reads or future writes. Existing path
 * components are canonicalized, so an escaping intermediate symlink is refused
 * even when the leaf does not exist yet.
 */
export function resolveWithinRoot(repositoryRoot: string, relativePath: string): string {
  if (isPlatformAbsolutePath(relativePath)) {
    throw new SaberError(`path escapes repository root: ${relativePath}`);
  }

  const lexicalRoot = resolve(repositoryRoot);
  const lexicalCandidate = resolve(lexicalRoot, relativePath);

  if (isOutsideRoot(lexicalRoot, lexicalCandidate)) {
    throw new SaberError(`path escapes repository root: ${relativePath}`);
  }

  const canonicalRoot = realpathSync(lexicalRoot);
  const ancestor = nearestExistingAncestor(lexicalCandidate);
  const canonicalAncestor = realpathSync(ancestor);
  const canonicalCandidate = resolve(
    canonicalAncestor,
    relative(ancestor, lexicalCandidate),
  );

  if (isOutsideRoot(canonicalRoot, canonicalCandidate)) {
    throw new SaberError(`path escapes repository root: ${relativePath}`);
  }

  return canonicalCandidate;
}

/**
 * Re-check an existing file through symlinks before opening it. This keeps read
 * callers safe if a path changed between lexical resolution and file access.
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
