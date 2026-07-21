import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SaberError } from "./errors.js";
import { resolveWithinRoot } from "./files.js";
import type {
  ExternalAsset,
  ExternalAssetPackage,
  ExternalAssetsConfig,
} from "./models.js";
import {
  isExternalAssetCategory,
  isSafeExternalAssetDescription,
  isSafeExternalAssetId,
  isSafeExternalAssetPackagePath,
  isSafeExternalAssetSource,
} from "./validation.js";

// A versioned owned namespace keeps legacy ignored data completely out of the
// update trust boundary. Older `.saber/cache/<asset>` and
// `.saber/external/{skills,mcp}/...` paths are neither read nor modified.
const cacheRootRelativePath = ".saber/cache/saber-v1";
const externalRootRelativePath = ".saber/external/saber-v1";
const generatedCacheMarker = ".saber-cache.json";
const generatedPackageMarker = ".saber-package.json";
const generatedManifestFilename = "manifest.json";
const externalManifestOwner = "saber";
const stagingDirectoryPrefix = ".saber-stage-";
const backupDirectoryPrefix = ".saber-backup-";
const manifestTemporaryFilenamePrefix = ".saber-manifest-";

export type ExternalAssetState = "missing" | "git-checkout" | "conflict";
export type ExternalAssetUpdateMode = "clone" | "pull" | "conflict";
export type ExternalPackageState = "missing" | "managed" | "conflict";
export type ExternalPackageUpdateMode = "materialize" | "conflict";

export type PlannedExternalCommand = {
  program: "git";
  args: readonly string[];
};

export type SelectedExternalPackageOperation = {
  id: string;
  sourcePath: string;
  destination: string;
  state: ExternalPackageState;
  mode: ExternalPackageUpdateMode;
};

/** A serializable preview that contains paths and redacted commands only. */
export type ExternalAssetOperation = {
  assetId: string;
  category: ExternalAsset["category"];
  description: string;
  sourceStatus: "configured";
  cache: string;
  state: ExternalAssetState;
  mode: ExternalAssetUpdateMode;
  commands: readonly PlannedExternalCommand[];
  /** Human action required when a managed cache cannot be safely updated. */
  recovery?: string;
  selectedPackages: readonly SelectedExternalPackageOperation[];
};

export type FileStatus = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type DirectoryEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

/** File operations are injected so update planning/execution can be tested without a real Git remote. */
export type ExternalAssetFileSystem = {
  lstat(path: string): Promise<FileStatus>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  readdir(path: string): Promise<DirectoryEntry[]>;
  copyFile(source: string, destination: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
};

export type CommandResult = {
  exitCode: number;
  stdout?: string;
};

/** Commands are passed as program/argument vectors, never through a shell. */
export type CommandRunner = (command: PlannedExternalCommand) => Promise<CommandResult>;

export type ExternalAssetDependencies = {
  fileSystem?: ExternalAssetFileSystem;
  runner?: CommandRunner;
};

type AssetPaths = {
  cacheRootPath: string;
  cachePath: string;
  externalAreaRelativePath: string;
  externalAreaPath: string;
  externalAssetPath: string;
};

type PackagePaths = {
  parentPath: string;
  destinationPath: string;
  destinationRelativePath: string;
};

type MaterializedPackageMarker = {
  schemaVersion: 1;
  assetId: string;
  packageId: string;
  sourcePath: string;
};

type ManagedCacheMarker = {
  schemaVersion: 1;
  assetId: string;
  sourceFingerprint: string;
};

type ExternalManifestEntry = {
  id: string;
  assetId: string;
  packageId: string;
  category: ExternalAsset["category"];
  sourcePath: string;
  materializedPath: string;
  revision: string | null;
};

type ExternalManifest = {
  schemaVersion: 1;
  managedBy: typeof externalManifestOwner;
  packages: ExternalManifestEntry[];
};

const nodeFileSystem: ExternalAssetFileSystem = {
  lstat: async (path) => lstat(path),
  mkdir: async (path, options) => mkdir(path, options),
  readdir: async (path) => readdir(path, { withFileTypes: true }),
  copyFile: async (source, destination) => copyFile(source, destination),
  readFile: async (path) => readFile(path, "utf8"),
  writeFile: async (path, content) => writeFile(path, content, "utf8"),
  rename: async (source, destination) => rename(source, destination),
  rm: async (path, options) => rm(path, options),
};

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isWithin(parent: string, child: string, allowEqual: boolean): boolean {
  const pathFromParent = relative(parent, child);
  if (pathFromParent.length === 0) {
    return allowEqual;
  }

  return (
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function externalAreaName(asset: ExternalAsset): "skills" | "mcp" {
  return asset.category === "skill-collection" ? "skills" : "mcp";
}

function cacheRelativePath(asset: ExternalAsset): string {
  return `${cacheRootRelativePath}/${asset.id}`;
}

function cacheConflictRecovery(asset: ExternalAsset): string {
  return `Review ${cacheRelativePath(asset)}; Saber will not overwrite it. If it is safe to discard, remove it and re-run external update.`;
}

function externalAreaRelativePath(asset: ExternalAsset): string {
  return `${externalRootRelativePath}/${externalAreaName(asset)}`;
}

function materializedPackageRelativePath(
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
): string {
  return `${externalAreaRelativePath(asset)}/${asset.id}/${selectedPackage.id}`;
}

function assertRegistryAsset(asset: ExternalAsset): void {
  if (!isSafeExternalAssetId(asset.id)) {
    throw new SaberError("invalid external asset id", 2);
  }
  if (!isExternalAssetCategory(asset.category)) {
    throw new SaberError("invalid external asset category", 2);
  }
  if (asset.kind !== "git") {
    throw new SaberError("unsupported external asset kind", 2);
  }
  if (!isSafeExternalAssetDescription(asset.description)) {
    throw new SaberError("external asset description must be a single safe line", 2);
  }
  if (!isSafeExternalAssetSource(asset.source)) {
    throw new SaberError("external asset source must be a safe Git remote", 2);
  }
  if (!Array.isArray(asset.packages) || asset.packages.length === 0) {
    throw new SaberError("external asset must select at least one package", 2);
  }

  const packageIds = new Set<string>();
  const packagePaths = new Set<string>();
  for (const selectedPackage of asset.packages) {
    if (!isSafeExternalAssetId(selectedPackage.id)) {
      throw new SaberError("invalid external skill package id", 2);
    }
    if (!isSafeExternalAssetPackagePath(selectedPackage.sourcePath)) {
      throw new SaberError("invalid external skill package path", 2);
    }
    if (
      asset.category === "skill-collection" &&
      !selectedPackage.sourcePath.startsWith("skills/")
    ) {
      throw new SaberError("external skill package path must be below skills/", 2);
    }
    if (packageIds.has(selectedPackage.id) || packagePaths.has(selectedPackage.sourcePath)) {
      throw new SaberError("external asset repeats a selected package", 2);
    }
    packageIds.add(selectedPackage.id);
    packagePaths.add(selectedPackage.sourcePath);
  }
}

function resolveAssetPaths(repositoryRoot: string, asset: ExternalAsset): AssetPaths {
  assertRegistryAsset(asset);

  const cacheRootPath = resolveWithinRoot(repositoryRoot, cacheRootRelativePath);
  const cachePath = resolveWithinRoot(repositoryRoot, cacheRelativePath(asset));
  const externalAreaRelative = externalAreaRelativePath(asset);
  const externalAreaPath = resolveWithinRoot(repositoryRoot, externalAreaRelative);
  const externalAssetPath = resolveWithinRoot(
    repositoryRoot,
    `${externalAreaRelative}/${asset.id}`,
  );

  if (
    !isWithin(cacheRootPath, cachePath, false) ||
    !isWithin(externalAreaPath, externalAssetPath, false)
  ) {
    throw new SaberError("external asset path escapes its managed root", 2);
  }

  return {
    cacheRootPath,
    cachePath,
    externalAreaRelativePath: externalAreaRelative,
    externalAreaPath,
    externalAssetPath,
  };
}

/**
 * `resolveWithinRoot` intentionally permits links that remain inside a repository.
 * External asset roots are stricter: a link would make the managed location
 * ambiguous and can redirect an update into unrelated repository content.
 */
async function assertManagedPathHasNoSymbolicLinks(
  repositoryRoot: string,
  relativePath: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  let currentPath = resolve(repositoryRoot);
  for (const segment of relativePath.split(/[\\/]+/u)) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new SaberError("external managed path is invalid", 2);
    }
    currentPath = join(currentPath, segment);
    const status = await lstatIfPresent(fileSystem, currentPath);
    if (status?.isSymbolicLink()) {
      throw new SaberError("external managed path must not contain symbolic links", 2);
    }
  }
}

async function assertAssetPathsHaveNoSymbolicLinks(
  repositoryRoot: string,
  asset: ExternalAsset,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  for (const relativePath of [
    cacheRootRelativePath,
    cacheRelativePath(asset),
    externalRootRelativePath,
    externalAreaRelativePath(asset),
    `${externalAreaRelativePath(asset)}/${asset.id}`,
  ]) {
    await assertManagedPathHasNoSymbolicLinks(repositoryRoot, relativePath, fileSystem);
  }
}

function resolvePackagePaths(
  repositoryRoot: string,
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
  paths: AssetPaths,
): PackagePaths {
  const destinationRelativePath = materializedPackageRelativePath(asset, selectedPackage);
  const parentPath = resolveWithinRoot(repositoryRoot, dirname(destinationRelativePath));
  const destinationPath = resolveWithinRoot(repositoryRoot, destinationRelativePath);

  if (
    !isWithin(paths.externalAreaPath, parentPath, true) ||
    !isWithin(paths.externalAreaPath, destinationPath, false)
  ) {
    throw new SaberError("external package destination escapes its managed root", 2);
  }

  return { parentPath, destinationPath, destinationRelativePath };
}

function resolvePackageSource(
  cachePath: string,
  selectedPackage: ExternalAssetPackage,
): string {
  const parentPath = resolveWithinRoot(cachePath, dirname(selectedPackage.sourcePath));
  const sourcePath = resolveWithinRoot(cachePath, selectedPackage.sourcePath);
  if (!isWithin(cachePath, parentPath, true) || !isWithin(cachePath, sourcePath, false)) {
    throw new SaberError("selected package source path escapes the sparse cache", 2);
  }
  return sourcePath;
}

async function lstatIfPresent(
  fileSystem: ExternalAssetFileSystem,
  path: string,
): Promise<FileStatus | undefined> {
  try {
    return await fileSystem.lstat(path);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

function sourceFingerprint(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function cacheMarkerFor(asset: ExternalAsset): ManagedCacheMarker {
  return {
    schemaVersion: 1,
    assetId: asset.id,
    sourceFingerprint: sourceFingerprint(asset.source),
  };
}

function cacheMarkerMatches(text: string, asset: ExternalAsset): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const marker = parsed as Partial<ManagedCacheMarker>;
    const expected = cacheMarkerFor(asset);
    return (
      marker.schemaVersion === expected.schemaVersion &&
      marker.assetId === expected.assetId &&
      marker.sourceFingerprint === expected.sourceFingerprint
    );
  } catch {
    return false;
  }
}

function cacheMarkerText(asset: ExternalAsset): string {
  return `${JSON.stringify(cacheMarkerFor(asset), null, 2)}\n`;
}

async function writeManagedCacheMarker(
  repositoryRoot: string,
  asset: ExternalAsset,
  paths: AssetPaths,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
  const markerPath = join(paths.cachePath, generatedCacheMarker);
  await assertManagedPathHasNoSymbolicLinks(
    repositoryRoot,
    `${cacheRelativePath(asset)}/${generatedCacheMarker}`,
    fileSystem,
  );
  const marker = await lstatIfPresent(fileSystem, markerPath);
  if (marker !== undefined && !marker.isFile()) {
    throw new SaberError("external cache marker is not a regular file", 1);
  }
  await fileSystem.writeFile(markerPath, cacheMarkerText(asset));
}

/**
 * A Git control area and a selected package tree are separate trust boundaries.
 * This deliberately checks only those managed/selected trees, not arbitrary
 * upstream checkout files that are outside Saber’s materialization scope.
 */
async function isRegularDirectoryTreeWithoutUnsafeEntries(
  directoryPath: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<boolean> {
  try {
    const directory = await lstatIfPresent(fileSystem, directoryPath);
    return (
      directory !== undefined &&
      directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      !(await containsUnsafeFilesystemEntry(directoryPath, fileSystem))
    );
  } catch {
    // An unreadable or concurrently modified managed tree cannot be proven
    // safe, so callers must treat it as a conflict rather than proceeding.
    return false;
  }
}

async function assertCacheReadyForGitCommand(
  repositoryRoot: string,
  asset: ExternalAsset,
  paths: AssetPaths,
  requireManagedMarker: boolean,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
  const cache = await lstatIfPresent(fileSystem, paths.cachePath);
  if (cache === undefined || !cache.isDirectory() || cache.isSymbolicLink()) {
    throw new SaberError("external cache is unavailable; remove the managed cache and re-clone", 1);
  }

  const markerPath = join(paths.cachePath, generatedCacheMarker);
  const marker = await lstatIfPresent(fileSystem, markerPath);
  if (
    marker !== undefined &&
    (!marker.isFile() || marker.isSymbolicLink())
  ) {
    throw new SaberError("external cache marker is unsafe; remove the managed cache and re-clone", 1);
  }
  if (requireManagedMarker) {
    let markerText: string | undefined;
    try {
      markerText = marker === undefined ? undefined : await fileSystem.readFile(markerPath);
    } catch {
      markerText = undefined;
    }
    if (markerText === undefined || !cacheMarkerMatches(markerText, asset)) {
      throw new SaberError("external cache marker is unsafe; remove the managed cache and re-clone", 1);
    }
  }

  if (
    !(await isRegularDirectoryTreeWithoutUnsafeEntries(
      join(paths.cachePath, ".git"),
      fileSystem,
    ))
  ) {
    throw new SaberError(
      "external cache Git control area is unsafe; remove the managed cache and re-clone",
      1,
    );
  }
}

async function inspectCache(
  asset: ExternalAsset,
  paths: AssetPaths,
  fileSystem: ExternalAssetFileSystem,
): Promise<ExternalAssetState> {
  const cacheRoot = await lstatIfPresent(fileSystem, paths.cacheRootPath);
  if (cacheRoot !== undefined && !cacheRoot.isDirectory()) {
    return "conflict";
  }

  const cache = await lstatIfPresent(fileSystem, paths.cachePath);
  if (cache === undefined) {
    return "missing";
  }
  if (!cache.isDirectory()) {
    return "conflict";
  }

  const gitMetadata = await lstatIfPresent(fileSystem, join(paths.cachePath, ".git"));
  if (!gitMetadata?.isDirectory()) {
    return "conflict";
  }
  if (!(await isRegularDirectoryTreeWithoutUnsafeEntries(join(paths.cachePath, ".git"), fileSystem))) {
    return "conflict";
  }

  const markerPath = join(paths.cachePath, generatedCacheMarker);
  const marker = await lstatIfPresent(fileSystem, markerPath);
  if (marker === undefined || !marker.isFile()) {
    return "conflict";
  }

  try {
    return cacheMarkerMatches(await fileSystem.readFile(markerPath), asset)
      ? "git-checkout"
      : "conflict";
  } catch {
    return "conflict";
  }
}

function markerFor(
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
): MaterializedPackageMarker {
  return {
    schemaVersion: 1,
    assetId: asset.id,
    packageId: selectedPackage.id,
    sourcePath: selectedPackage.sourcePath,
  };
}

function markerText(asset: ExternalAsset, selectedPackage: ExternalAssetPackage): string {
  return `${JSON.stringify(markerFor(asset, selectedPackage), null, 2)}\n`;
}

function markerMatches(
  text: string,
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const marker = parsed as Partial<MaterializedPackageMarker>;
    return (
      marker.schemaVersion === 1 &&
      marker.assetId === asset.id &&
      marker.packageId === selectedPackage.id &&
      marker.sourcePath === selectedPackage.sourcePath
    );
  } catch {
    return false;
  }
}

async function inspectMaterializedPackage(
  repositoryRoot: string,
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
  paths: AssetPaths,
  fileSystem: ExternalAssetFileSystem,
): Promise<ExternalPackageState> {
  await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
  const externalArea = await lstatIfPresent(fileSystem, paths.externalAreaPath);
  if (externalArea !== undefined && !externalArea.isDirectory()) {
    return "conflict";
  }
  const externalAsset = await lstatIfPresent(fileSystem, paths.externalAssetPath);
  if (externalAsset !== undefined && !externalAsset.isDirectory()) {
    return "conflict";
  }

  const packagePaths = resolvePackagePaths(repositoryRoot, asset, selectedPackage, paths);
  await assertManagedPathHasNoSymbolicLinks(
    repositoryRoot,
    packagePaths.destinationRelativePath,
    fileSystem,
  );
  const target = await lstatIfPresent(fileSystem, packagePaths.destinationPath);
  if (target === undefined) {
    return "missing";
  }
  if (!target.isDirectory()) {
    return "conflict";
  }

  const markerPath = join(packagePaths.destinationPath, generatedPackageMarker);
  const marker = await lstatIfPresent(fileSystem, markerPath);
  if (marker === undefined || !marker.isFile()) {
    return "conflict";
  }

  if (!markerMatches(await fileSystem.readFile(markerPath), asset, selectedPackage)) {
    return "conflict";
  }

  return (await containsUnsafeFilesystemEntry(packagePaths.destinationPath, fileSystem))
    ? "conflict"
    : "managed";
}

function selectAssets(
  externalAssets: ExternalAssetsConfig,
  requestedId: string | undefined,
): ExternalAsset[] {
  const seenIds = new Set<string>();
  for (const asset of externalAssets.assets) {
    assertRegistryAsset(asset);
    if (seenIds.has(asset.id)) {
      throw new SaberError(`duplicate external asset id ${asset.id}`, 2);
    }
    seenIds.add(asset.id);
  }

  if (requestedId === undefined) {
    return externalAssets.assets;
  }
  if (!isSafeExternalAssetId(requestedId)) {
    throw new SaberError("invalid external asset id", 2);
  }

  const asset = externalAssets.assets.find((candidate) => candidate.id === requestedId);
  if (asset === undefined) {
    throw new SaberError("unknown external asset id", 2);
  }

  return [asset];
}

/** Remove URL userinfo, query parameters, and fragments before displaying a Git source. */
export function redactExternalAssetSource(source: string): string {
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const scpStyle = source.match(/^[^@]+@([^:]+):(.+)$/u);
    if (scpStyle?.[1] !== undefined && scpStyle[2] !== undefined) {
      return `ssh://${scpStyle[1]}/${scpStyle[2]}`;
    }
    return source;
  }
}

function cloneCommand(source: string, cachePath: string): PlannedExternalCommand {
  return {
    program: "git",
    // Prevent repository-local or globally configured checkout hooks from
    // running while an external asset is first cloned.
    args: [
      "-c",
      `core.hooksPath=${devNull}`,
      "clone",
      "--filter=blob:none",
      "--sparse",
      source,
      cachePath,
    ],
  };
}

/** Compile validated source paths into anchored, recursive non-cone patterns. */
function sparseCheckoutPattern(sourcePath: string): string {
  return `/${sourcePath}/**`;
}

function sparseCheckoutCommand(asset: ExternalAsset, cachePath: string): PlannedExternalCommand {
  return {
    program: "git",
    args: [
      "-c",
      `core.hooksPath=${devNull}`,
      "-C",
      cachePath,
      "sparse-checkout",
      "set",
      "--no-cone",
      ...asset.packages.map((selectedPackage) => sparseCheckoutPattern(selectedPackage.sourcePath)),
    ],
  };
}

function revisionCommand(cachePath: string): PlannedExternalCommand {
  return { program: "git", args: ["-C", cachePath, "rev-parse", "HEAD"] };
}

function verifyOriginCommand(cachePath: string): PlannedExternalCommand {
  return { program: "git", args: ["-C", cachePath, "remote", "get-url", "origin"] };
}

function pullCommand(cachePath: string): PlannedExternalCommand {
  return {
    program: "git",
    // A cache created by Saber has no hooks, and this explicit override also
    // prevents a later local cache mutation from executing a post-merge hook.
    args: [
      "-c",
      `core.hooksPath=${devNull}`,
      "-C",
      cachePath,
      "pull",
      "--ff-only",
      "origin",
    ],
  };
}

function createCommands(
  asset: ExternalAsset,
  mode: Exclude<ExternalAssetUpdateMode, "conflict">,
  cachePath: string,
  source: string,
): readonly PlannedExternalCommand[] {
  if (mode === "clone") {
    return [
      cloneCommand(source, cachePath),
      verifyOriginCommand(cachePath),
      sparseCheckoutCommand(asset, cachePath),
      revisionCommand(cachePath),
    ];
  }

  return [
    verifyOriginCommand(cachePath),
    sparseCheckoutCommand(asset, cachePath),
    pullCommand(cachePath),
    revisionCommand(cachePath),
  ];
}

function createPreviewCommands(
  asset: ExternalAsset,
  mode: Exclude<ExternalAssetUpdateMode, "conflict">,
): readonly PlannedExternalCommand[] {
  return createCommands(asset, mode, cacheRelativePath(asset), redactExternalAssetSource(asset.source));
}

/** Inspect the registry and produce a safe, non-mutating sparse update preview. */
export async function planExternalAssetUpdates(
  repositoryRoot: string,
  externalAssets: ExternalAssetsConfig,
  requestedId?: string,
  dependencies: Pick<ExternalAssetDependencies, "fileSystem"> = {},
): Promise<ExternalAssetOperation[]> {
  const fileSystem = dependencies.fileSystem ?? nodeFileSystem;
  const assets = selectAssets(externalAssets, requestedId);
  const operations: ExternalAssetOperation[] = [];

  for (const asset of assets) {
    await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
    const paths = resolveAssetPaths(repositoryRoot, asset);
    const state = await inspectCache(asset, paths, fileSystem);
    const selectedPackages: SelectedExternalPackageOperation[] = await Promise.all(
      asset.packages.map(async (selectedPackage) => {
        const packageState = await inspectMaterializedPackage(
          repositoryRoot,
          asset,
          selectedPackage,
          paths,
          fileSystem,
        );
        return {
          id: selectedPackage.id,
          sourcePath: selectedPackage.sourcePath,
          destination: materializedPackageRelativePath(asset, selectedPackage),
          state: packageState,
          mode:
            packageState === "conflict"
              ? ("conflict" as const)
              : ("materialize" as const),
        };
      }),
    );

    const base = {
      assetId: asset.id,
      category: asset.category,
      description: asset.description,
      sourceStatus: "configured" as const,
      cache: cacheRelativePath(asset),
      state,
      selectedPackages,
    };
    if (state === "missing") {
      operations.push({ ...base, mode: "clone", commands: createPreviewCommands(asset, "clone") });
    } else if (state === "git-checkout") {
      operations.push({ ...base, mode: "pull", commands: createPreviewCommands(asset, "pull") });
    } else {
      operations.push({
        ...base,
        mode: "conflict",
        commands: [],
        recovery: cacheConflictRecovery(asset),
      });
    }
  }

  return operations;
}

async function runGitCommand(command: PlannedExternalCommand): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", () => reject(new SaberError("could not execute git", 1)));
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

async function assertCacheOrigin(
  repositoryRoot: string,
  asset: ExternalAsset,
  paths: AssetPaths,
  requireManagedMarker: boolean,
  fileSystem: ExternalAssetFileSystem,
  runner: CommandRunner,
): Promise<void> {
  await assertCacheReadyForGitCommand(
    repositoryRoot,
    asset,
    paths,
    requireManagedMarker,
    fileSystem,
  );
  const originResult = await runner(verifyOriginCommand(paths.cachePath));
  if (originResult.exitCode !== 0 || originResult.stdout?.trim() !== asset.source) {
    throw new SaberError("external cache origin does not match configured source", 1);
  }
}

async function runExternalAssetUpdateCommand(
  asset: ExternalAsset,
  command: PlannedExternalCommand,
  runner: CommandRunner,
): Promise<void> {
  const result = await runner(command);
  if (result.exitCode !== 0) {
    throw new SaberError(`external asset ${asset.id} update failed`, 1);
  }
}

function samePlan(expected: ExternalAssetOperation, current: ExternalAssetOperation): boolean {
  return (
    expected.assetId === current.assetId &&
    expected.mode === current.mode &&
    expected.state === current.state &&
    expected.selectedPackages.length === current.selectedPackages.length &&
    expected.selectedPackages.every((selectedPackage, index) => {
      const currentPackage = current.selectedPackages[index];
      return (
        currentPackage !== undefined &&
        selectedPackage.id === currentPackage.id &&
        selectedPackage.sourcePath === currentPackage.sourcePath &&
        selectedPackage.destination === currentPackage.destination &&
        selectedPackage.state === currentPackage.state &&
        selectedPackage.mode === currentPackage.mode
      );
    })
  );
}

function normalizeRevision(result: CommandResult): string | null {
  const revision = result.stdout?.trim();
  return revision !== undefined && /^[0-9a-f]{7,64}$/iu.test(revision) ? revision : null;
}

async function validatePackageSource(
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
  paths: AssetPaths,
  fileSystem: ExternalAssetFileSystem,
): Promise<string> {
  await assertManagedPathHasNoSymbolicLinks(
    paths.cachePath,
    selectedPackage.sourcePath,
    fileSystem,
  );
  const sourcePath = resolvePackageSource(paths.cachePath, selectedPackage);
  const source = await lstatIfPresent(fileSystem, sourcePath);
  if (source === undefined || !source.isDirectory()) {
    throw new SaberError("selected package was not found in the sparse cache", 1);
  }
  await assertSelectedPackageSourceTreeIsSafe(sourcePath, fileSystem);

  if (asset.category === "skill-collection") {
    const skillFile = await lstatIfPresent(fileSystem, join(sourcePath, "SKILL.md"));
    if (skillFile === undefined || !skillFile.isFile()) {
      throw new SaberError("selected skill package must contain SKILL.md", 1);
    }
  }

  return sourcePath;
}

async function assertSelectedPackageSourceTreeIsSafe(
  sourcePath: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  if (!(await isRegularDirectoryTreeWithoutUnsafeEntries(sourcePath, fileSystem))) {
    throw new SaberError("selected package source tree contains an unsafe entry", 1);
  }
}

function isSafeEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

async function containsUnsafeFilesystemEntry(
  directoryPath: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<boolean> {
  const entries = await fileSystem.readdir(directoryPath);
  for (const entry of entries) {
    if (!isSafeEntryName(entry.name)) {
      return true;
    }
    const childPath = join(directoryPath, entry.name);
    const status = await fileSystem.lstat(childPath);
    if (status.isSymbolicLink()) {
      return true;
    }
    if (status.isDirectory()) {
      if (await containsUnsafeFilesystemEntry(childPath, fileSystem)) {
        return true;
      }
    } else if (!status.isFile()) {
      return true;
    }
  }
  return false;
}

async function copyPackageTree(
  repositoryRoot: string,
  sourcePath: string,
  destinationPath: string,
  destinationRelativePath: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  await assertManagedPathHasNoSymbolicLinks(
    repositoryRoot,
    destinationRelativePath,
    fileSystem,
  );
  const destination = await lstatIfPresent(fileSystem, destinationPath);
  if (destination === undefined || !destination.isDirectory() || destination.isSymbolicLink()) {
    throw new SaberError("external package staging directory is unavailable", 1);
  }
  const source = await lstatIfPresent(fileSystem, sourcePath);
  if (source === undefined || !source.isDirectory() || source.isSymbolicLink()) {
    throw new SaberError("selected package source is not a regular directory", 1);
  }
  const entries = await fileSystem.readdir(sourcePath);
  for (const entry of entries) {
    if (!isSafeEntryName(entry.name)) {
      throw new SaberError("selected package contains an unsafe entry name", 1);
    }
    if (entry.name === generatedPackageMarker) {
      continue;
    }

    const sourceChild = join(sourcePath, entry.name);
    const destinationChild = join(destinationPath, entry.name);
    const destinationChildRelativePath = join(destinationRelativePath, entry.name);
    const status = await fileSystem.lstat(sourceChild);
    if (status.isSymbolicLink()) {
      throw new SaberError("selected package contains a symbolic link", 1);
    }
    if (status.isDirectory()) {
      if ((await lstatIfPresent(fileSystem, destinationChild)) !== undefined) {
        throw new SaberError("external package staging directory changed during materialization", 1);
      }
      await assertManagedPathHasNoSymbolicLinks(
        repositoryRoot,
        destinationChildRelativePath,
        fileSystem,
      );
      await fileSystem.mkdir(destinationChild, { recursive: false });
      await assertManagedPathHasNoSymbolicLinks(
        repositoryRoot,
        destinationChildRelativePath,
        fileSystem,
      );
      await copyPackageTree(
        repositoryRoot,
        sourceChild,
        destinationChild,
        destinationChildRelativePath,
        fileSystem,
      );
    } else if (status.isFile()) {
      if ((await lstatIfPresent(fileSystem, destinationChild)) !== undefined) {
        throw new SaberError("external package staging directory changed during materialization", 1);
      }
      await assertManagedPathHasNoSymbolicLinks(
        repositoryRoot,
        destinationChildRelativePath,
        fileSystem,
      );
      await fileSystem.copyFile(sourceChild, destinationChild);
    } else {
      throw new SaberError("selected package contains an unsupported filesystem entry", 1);
    }
  }
}

type TemporaryPackagePath = {
  path: string;
  relativePath: string;
};

function createTemporaryPackagePath(
  repositoryRoot: string,
  packagePaths: PackagePaths,
  prefix: string,
): TemporaryPackagePath {
  const relativePath = `${dirname(packagePaths.destinationRelativePath)}/${prefix}${randomUUID()}`;
  const path = resolveWithinRoot(repositoryRoot, relativePath);
  if (!isWithin(packagePaths.parentPath, path, false)) {
    throw new SaberError("external package temporary path escapes its managed parent", 2);
  }
  return { path, relativePath };
}

async function removeTemporaryPackagePath(
  repositoryRoot: string,
  temporaryPath: TemporaryPackagePath,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  try {
    await assertManagedPathHasNoSymbolicLinks(
      repositoryRoot,
      temporaryPath.relativePath,
      fileSystem,
    );
    const status = await lstatIfPresent(fileSystem, temporaryPath.path);
    if (status?.isDirectory() && !status.isSymbolicLink()) {
      await fileSystem.rm(temporaryPath.path, { recursive: true, force: true });
    }
  } catch {
    // A failed best-effort cleanup must never broaden into a deletion outside
    // the dedicated staging path.
  }
}

async function promoteStagedPackage(
  repositoryRoot: string,
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
  paths: AssetPaths,
  packagePaths: PackagePaths,
  initialState: Exclude<ExternalPackageState, "conflict">,
  stagingPath: TemporaryPackagePath,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  const currentState = await inspectMaterializedPackage(
    repositoryRoot,
    asset,
    selectedPackage,
    paths,
    fileSystem,
  );
  if (currentState !== initialState) {
    throw new SaberError("external package destination changed before replacement", 1);
  }
  await assertManagedPathHasNoSymbolicLinks(
    repositoryRoot,
    packagePaths.destinationRelativePath,
    fileSystem,
  );
  await assertManagedPathHasNoSymbolicLinks(
    repositoryRoot,
    stagingPath.relativePath,
    fileSystem,
  );

  if (initialState === "missing") {
    if ((await lstatIfPresent(fileSystem, packagePaths.destinationPath)) !== undefined) {
      throw new SaberError("external package destination changed before replacement", 1);
    }
    await fileSystem.rename(stagingPath.path, packagePaths.destinationPath);
    return;
  }

  const backupPath = createTemporaryPackagePath(
    repositoryRoot,
    packagePaths,
    backupDirectoryPrefix,
  );
  if ((await lstatIfPresent(fileSystem, backupPath.path)) !== undefined) {
    throw new SaberError("external package backup path already exists", 1);
  }
  await assertManagedPathHasNoSymbolicLinks(
    repositoryRoot,
    backupPath.relativePath,
    fileSystem,
  );
  await fileSystem.rename(packagePaths.destinationPath, backupPath.path);

  try {
    await assertManagedPathHasNoSymbolicLinks(
      repositoryRoot,
      packagePaths.destinationRelativePath,
      fileSystem,
    );
    if ((await lstatIfPresent(fileSystem, packagePaths.destinationPath)) !== undefined) {
      throw new SaberError("external package destination changed before replacement", 1);
    }
    await fileSystem.rename(stagingPath.path, packagePaths.destinationPath);
  } catch (error: unknown) {
    try {
      await assertManagedPathHasNoSymbolicLinks(
        repositoryRoot,
        packagePaths.destinationRelativePath,
        fileSystem,
      );
      if ((await lstatIfPresent(fileSystem, packagePaths.destinationPath)) === undefined) {
        await fileSystem.rename(backupPath.path, packagePaths.destinationPath);
      }
    } catch {
      // Preserve the original replacement error while leaving the explicit
      // backup path intact for manual recovery if rollback is also blocked.
    }
    throw error;
  }

  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, backupPath.relativePath, fileSystem);
  await fileSystem.rm(backupPath.path, { recursive: true, force: false });
}

async function materializePackage(
  repositoryRoot: string,
  asset: ExternalAsset,
  selectedPackage: ExternalAssetPackage,
  paths: AssetPaths,
  sourcePath: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  // Source validation happened after sparse checkout; repeat it at the
  // materialization boundary so a later local mutation cannot move links into
  // a staged package tree.
  await assertSelectedPackageSourceTreeIsSafe(sourcePath, fileSystem);
  const currentState = await inspectMaterializedPackage(
    repositoryRoot,
    asset,
    selectedPackage,
    paths,
    fileSystem,
  );
  if (currentState === "conflict") {
    throw new SaberError("external package destination changed before materialization", 1);
  }

  await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
  let packagePaths = resolvePackagePaths(repositoryRoot, asset, selectedPackage, paths);
  const parentRelativePath = dirname(packagePaths.destinationRelativePath);
  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, parentRelativePath, fileSystem);
  await fileSystem.mkdir(packagePaths.parentPath, { recursive: true });
  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, parentRelativePath, fileSystem);
  const refreshedPaths = resolveAssetPaths(repositoryRoot, asset);
  packagePaths = resolvePackagePaths(repositoryRoot, asset, selectedPackage, refreshedPaths);
  const stagingPath = createTemporaryPackagePath(
    repositoryRoot,
    packagePaths,
    stagingDirectoryPrefix,
  );
  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, stagingPath.relativePath, fileSystem);
  if ((await lstatIfPresent(fileSystem, stagingPath.path)) !== undefined) {
    throw new SaberError("external package staging path already exists", 1);
  }
  await fileSystem.mkdir(stagingPath.path, { recursive: false });

  try {
    await assertManagedPathHasNoSymbolicLinks(repositoryRoot, stagingPath.relativePath, fileSystem);
    await copyPackageTree(
      repositoryRoot,
      sourcePath,
      stagingPath.path,
      stagingPath.relativePath,
      fileSystem,
    );
    const markerPath = join(stagingPath.path, generatedPackageMarker);
    const markerRelativePath = join(stagingPath.relativePath, generatedPackageMarker);
    await assertManagedPathHasNoSymbolicLinks(repositoryRoot, markerRelativePath, fileSystem);
    if ((await lstatIfPresent(fileSystem, markerPath)) !== undefined) {
      throw new SaberError("external package staging marker already exists", 1);
    }
    await fileSystem.writeFile(markerPath, markerText(asset, selectedPackage));
    await promoteStagedPackage(
      repositoryRoot,
      asset,
      selectedPackage,
      refreshedPaths,
      packagePaths,
      currentState,
      stagingPath,
      fileSystem,
    );
  } catch (error: unknown) {
    await removeTemporaryPackagePath(repositoryRoot, stagingPath, fileSystem);
    throw error;
  }
}

function resolveManifestPath(repositoryRoot: string): { parentPath: string; manifestPath: string } {
  const parentPath = resolveWithinRoot(repositoryRoot, externalRootRelativePath);
  const manifestPath = resolveWithinRoot(
    repositoryRoot,
    `${externalRootRelativePath}/${generatedManifestFilename}`,
  );
  if (!isWithin(parentPath, manifestPath, false)) {
    throw new SaberError("external manifest path escapes its managed root", 2);
  }
  return { parentPath, manifestPath };
}

function isExternalManifestEntry(value: unknown): value is ExternalManifestEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<ExternalManifestEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.assetId === "string" &&
    typeof entry.packageId === "string" &&
    isExternalAssetCategory(entry.category) &&
    typeof entry.sourcePath === "string" &&
    typeof entry.materializedPath === "string" &&
    (typeof entry.revision === "string" || entry.revision === null)
  );
}

function parseManagedExternalManifest(text: string): ExternalManifest {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    const manifest = parsed as Partial<ExternalManifest>;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.managedBy !== externalManifestOwner ||
      !Array.isArray(manifest.packages) ||
      !manifest.packages.every((entry) => isExternalManifestEntry(entry))
    ) {
      throw new Error("not a Saber manifest");
    }
    return {
      schemaVersion: 1,
      managedBy: externalManifestOwner,
      packages: manifest.packages,
    };
  } catch {
    throw new SaberError("external manifest is not managed by Saber", 1);
  }
}

function emptyManagedExternalManifest(): ExternalManifest {
  return { schemaVersion: 1, managedBy: externalManifestOwner, packages: [] };
}

async function readManagedExternalManifest(
  repositoryRoot: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<ExternalManifest> {
  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, externalRootRelativePath, fileSystem);
  const manifestPaths = resolveManifestPath(repositoryRoot);
  const parent = await lstatIfPresent(fileSystem, manifestPaths.parentPath);
  if (parent === undefined) {
    return emptyManagedExternalManifest();
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new SaberError("external manifest parent is not a directory", 1);
  }
  const manifest = await lstatIfPresent(fileSystem, manifestPaths.manifestPath);
  if (manifest === undefined) {
    return emptyManagedExternalManifest();
  }
  if (!manifest.isFile() || manifest.isSymbolicLink()) {
    throw new SaberError("external manifest is not managed by Saber", 1);
  }
  return parseManagedExternalManifest(await fileSystem.readFile(manifestPaths.manifestPath));
}

function manifestRevisions(manifest: ExternalManifest): ReadonlyMap<string, string | null> {
  return new Map(manifest.packages.map((entry) => [entry.id, entry.revision]));
}

async function removeTemporaryManifest(
  repositoryRoot: string,
  temporaryRelativePath: string,
  temporaryPath: string,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  try {
    await assertManagedPathHasNoSymbolicLinks(repositoryRoot, temporaryRelativePath, fileSystem);
    const status = await lstatIfPresent(fileSystem, temporaryPath);
    if (status?.isFile() && !status.isSymbolicLink()) {
      await fileSystem.rm(temporaryPath, { recursive: false, force: true });
    }
  } catch {
    // The temporary file remains in the narrow manifest directory if a safe
    // cleanup cannot be proven; never broaden cleanup to a parent directory.
  }
}

async function writeManifest(
  repositoryRoot: string,
  externalAssets: ExternalAssetsConfig,
  revisions: ReadonlyMap<string, string | null>,
  fileSystem: ExternalAssetFileSystem,
): Promise<void> {
  const existingManifest = await readManagedExternalManifest(repositoryRoot, fileSystem);
  const preservedRevisions = manifestRevisions(existingManifest);
  const entries: ExternalManifestEntry[] = [];
  for (const asset of externalAssets.assets) {
    await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
    const paths = resolveAssetPaths(repositoryRoot, asset);
    for (const selectedPackage of asset.packages) {
      const state = await inspectMaterializedPackage(
        repositoryRoot,
        asset,
        selectedPackage,
        paths,
        fileSystem,
      );
      if (state !== "managed") {
        continue;
      }
      entries.push({
        id: `${asset.id}/${selectedPackage.id}`,
        assetId: asset.id,
        packageId: selectedPackage.id,
        category: asset.category,
        sourcePath: selectedPackage.sourcePath,
        materializedPath: materializedPackageRelativePath(asset, selectedPackage),
        revision:
          revisions.get(asset.id) ??
          preservedRevisions.get(`${asset.id}/${selectedPackage.id}`) ??
          null,
      });
    }
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));

  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, externalRootRelativePath, fileSystem);
  let manifestPaths = resolveManifestPath(repositoryRoot);
  const manifestParent = await lstatIfPresent(fileSystem, manifestPaths.parentPath);
  if (
    manifestParent !== undefined &&
    (!manifestParent.isDirectory() || manifestParent.isSymbolicLink())
  ) {
    throw new SaberError("external manifest parent is not a directory", 1);
  }
  await fileSystem.mkdir(manifestPaths.parentPath, { recursive: true });
  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, externalRootRelativePath, fileSystem);
  manifestPaths = resolveManifestPath(repositoryRoot);
  const temporaryRelativePath = `${externalRootRelativePath}/${manifestTemporaryFilenamePrefix}${randomUUID()}.json`;
  const temporaryPath = resolveWithinRoot(repositoryRoot, temporaryRelativePath);
  await assertManagedPathHasNoSymbolicLinks(repositoryRoot, temporaryRelativePath, fileSystem);
  if ((await lstatIfPresent(fileSystem, temporaryPath)) !== undefined) {
    throw new SaberError("external manifest staging path already exists", 1);
  }
  const payload = `${JSON.stringify(
    { schemaVersion: 1, managedBy: externalManifestOwner, packages: entries },
    null,
    2,
  )}\n`;
  await fileSystem.writeFile(temporaryPath, payload);

  try {
    await assertManagedPathHasNoSymbolicLinks(
      repositoryRoot,
      `${externalRootRelativePath}/${generatedManifestFilename}`,
      fileSystem,
    );
    await readManagedExternalManifest(repositoryRoot, fileSystem);
    await fileSystem.rename(temporaryPath, manifestPaths.manifestPath);
  } catch (error: unknown) {
    await removeTemporaryManifest(
      repositoryRoot,
      temporaryRelativePath,
      temporaryPath,
      fileSystem,
    );
    throw error;
  }
}

/**
 * Execute only previously planned sparse clone/pull operations, then copy only
 * selected package subtrees into the discoverable external skills layout.
 */
export async function executeExternalAssetUpdates(
  repositoryRoot: string,
  externalAssets: ExternalAssetsConfig,
  operations: readonly ExternalAssetOperation[],
  dependencies: ExternalAssetDependencies = {},
): Promise<void> {
  const fileSystem = dependencies.fileSystem ?? nodeFileSystem;
  const runner = dependencies.runner ?? runGitCommand;
  const conflictedOperation = operations.find((operation) => operation.mode === "conflict");
  if (conflictedOperation !== undefined) {
    throw new SaberError(
      `external asset ${conflictedOperation.assetId} has a cache conflict; ${
        conflictedOperation.recovery ??
        "Review the managed cache; do not overwrite it. If it is safe to discard, remove it and re-run external update."
      }`,
      1,
    );
  }
  // Reject a human-owned or malformed manifest before Git or filesystem update
  // side effects. The writer performs the same check again immediately before
  // its atomic replacement.
  await readManagedExternalManifest(repositoryRoot, fileSystem);
  const revisions = new Map<string, string | null>();

  for (const operation of operations) {
    if (operation.mode === "conflict") {
      continue;
    }
    const asset = externalAssets.assets.find((candidate) => candidate.id === operation.assetId);
    if (asset === undefined) {
      throw new SaberError("planned external asset is no longer registered", 2);
    }

    const current = await planExternalAssetUpdates(repositoryRoot, externalAssets, asset.id, {
      fileSystem,
    });
    if (current.length !== 1 || !samePlan(operation, current[0])) {
      throw new SaberError("external asset state changed before update", 1);
    }

    let paths = resolveAssetPaths(repositoryRoot, asset);
    if (operation.mode === "clone") {
      await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
      await fileSystem.mkdir(paths.cacheRootPath, { recursive: true });
      await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
      paths = resolveAssetPaths(repositoryRoot, asset);
      if ((await inspectCache(asset, paths, fileSystem)) !== "missing") {
        throw new SaberError("external asset state changed before update", 1);
      }
    }

    if (operation.mode === "clone") {
      // The cache has just been proven missing. Recheck immediately before the
      // only Git command that creates it, then inspect the new control area
      // before every subsequent command.
      await assertAssetPathsHaveNoSymbolicLinks(repositoryRoot, asset, fileSystem);
      if ((await inspectCache(asset, paths, fileSystem)) !== "missing") {
        throw new SaberError("external asset state changed before update", 1);
      }
      await runExternalAssetUpdateCommand(asset, cloneCommand(asset.source, paths.cachePath), runner);
      await assertCacheOrigin(repositoryRoot, asset, paths, false, fileSystem, runner);
      await assertCacheReadyForGitCommand(repositoryRoot, asset, paths, false, fileSystem);
      await runExternalAssetUpdateCommand(asset, sparseCheckoutCommand(asset, paths.cachePath), runner);
    } else {
      await assertCacheOrigin(repositoryRoot, asset, paths, true, fileSystem, runner);
      await assertCacheReadyForGitCommand(repositoryRoot, asset, paths, true, fileSystem);
      await runExternalAssetUpdateCommand(asset, sparseCheckoutCommand(asset, paths.cachePath), runner);
      await assertCacheReadyForGitCommand(repositoryRoot, asset, paths, true, fileSystem);
      await runExternalAssetUpdateCommand(asset, pullCommand(paths.cachePath), runner);
    }
    if (operation.mode === "clone") {
      await assertCacheReadyForGitCommand(repositoryRoot, asset, paths, false, fileSystem);
      await writeManagedCacheMarker(repositoryRoot, asset, paths, fileSystem);
    }
    await assertCacheReadyForGitCommand(repositoryRoot, asset, paths, true, fileSystem);
    const revisionResult = await runner(revisionCommand(paths.cachePath));
    revisions.set(asset.id, revisionResult.exitCode === 0 ? normalizeRevision(revisionResult) : null);

    paths = resolveAssetPaths(repositoryRoot, asset);
    if ((await inspectCache(asset, paths, fileSystem)) !== "git-checkout") {
      throw new SaberError("sparse Git cache is unavailable after update", 1);
    }

    const materializedPackages = operation.selectedPackages.filter(
      (selectedPackage) => selectedPackage.mode === "materialize",
    );
    const sources = await Promise.all(
      materializedPackages.map(async (selectedPackage) => {
        const configPackage = asset.packages.find(
          (candidate) => candidate.id === selectedPackage.id,
        );
        if (configPackage === undefined || configPackage.sourcePath !== selectedPackage.sourcePath) {
          throw new SaberError("planned external package is no longer registered", 2);
        }
        return {
          selectedPackage: configPackage,
          sourcePath: await validatePackageSource(asset, configPackage, paths, fileSystem),
        };
      }),
    );
    for (const source of sources) {
      await materializePackage(
        repositoryRoot,
        asset,
        source.selectedPackage,
        paths,
        source.sourcePath,
        fileSystem,
      );
    }
  }

  await writeManifest(repositoryRoot, externalAssets, revisions, fileSystem);
}
