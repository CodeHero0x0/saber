import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { loadRepositoryConfig } from "../src/lib/config.js";
import { SaberError } from "../src/lib/errors.js";
import {
  executeExternalAssetUpdates,
  planExternalAssetUpdates,
  redactExternalAssetSource,
  type CommandRunner,
} from "../src/lib/external-assets.js";
import type { ExternalAssetsConfig } from "../src/lib/models.js";
import { isSafeExternalAssetSource } from "../src/lib/validation.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type SelectedPackage = ExternalAssetsConfig["assets"][number]["packages"][number];

function selectedPackage(
  overrides: Partial<SelectedPackage> = {},
): SelectedPackage {
  return {
    id: "brainstorming",
    sourcePath: "skills/brainstorming",
    ...overrides,
  };
}

function asset(
  overrides: Partial<ExternalAssetsConfig["assets"][number]> = {},
): ExternalAssetsConfig["assets"][number] {
  return {
    id: "superpowers",
    category: "skill-collection",
    description: "团队可按需拉取的 Superpowers 技能集合。",
    kind: "git",
    source: "https://github.com/example/superpowers.git",
    packages: [selectedPackage()],
    ...overrides,
  };
}

function registry(assets: ExternalAssetsConfig["assets"]): ExternalAssetsConfig {
  return { schemaVersion: 1, assets };
}

function recordingRunner(
  commands: { program: string; args: readonly string[] }[],
  afterCommand?: (command: { program: string; args: readonly string[] }) => Promise<void>,
  origin = "https://github.com/example/superpowers.git",
): CommandRunner {
  return async (command) => {
    commands.push(command);
    await afterCommand?.(command);
    return {
      exitCode: 0,
      stdout: command.args.includes("rev-parse")
        ? "0123456789abcdef\n"
        : command.args.includes("remote")
          ? `${origin}\n`
          : "",
    };
  };
}

function expectedManagedCacheUpdateCommands(
  cachePath: string,
  sourcePaths: readonly string[],
): { program: string; args: readonly string[] }[] {
  return [
    {
      program: "git",
      args: ["-C", cachePath, "remote", "get-url", "origin"],
    },
    {
      program: "git",
      args: [
        "-c",
        `core.hooksPath=${devNull}`,
        "-C",
        cachePath,
        "sparse-checkout",
        "set",
        "--no-cone",
        ...sourcePaths.map((sourcePath) => `/${sourcePath}/**`),
      ],
    },
    {
      program: "git",
      args: ["-c", `core.hooksPath=${devNull}`, "-C", cachePath, "pull", "--ff-only", "origin"],
    },
    {
      program: "git",
      args: ["-C", cachePath, "rev-parse", "HEAD"],
    },
  ];
}

async function temporaryRepository(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function configWith(externalAssets: ExternalAssetsConfig) {
  const config = await loadRepositoryConfig(repositoryRoot);
  return { ...config, externalAssets };
}

async function writeCachedSkillPackage(
  cacheRoot: string,
  sourcePath: string,
): Promise<void> {
  const sourceDirectory = join(cacheRoot, sourcePath);
  await mkdir(join(sourceDirectory, "references"), { recursive: true });
  await writeFile(join(sourceDirectory, "SKILL.md"), "# Selected skill\n", "utf8");
  await writeFile(join(sourceDirectory, "references", "guide.md"), "guide\n", "utf8");
}

async function writeManagedCacheMarker(
  cacheRoot: string,
  {
    assetId = "superpowers",
    source = "https://github.com/example/superpowers.git",
  }: { assetId?: string; source?: string } = {},
): Promise<void> {
  const sourceFingerprint = createHash("sha256").update(source).digest("hex");
  await writeFile(
    join(cacheRoot, ".saber-cache.json"),
    `${JSON.stringify({ schemaVersion: 1, assetId, sourceFingerprint }, null, 2)}\n`,
    "utf8",
  );
}

async function writeManagedSkillPackage(
  destinationPath: string,
  {
    assetId = "superpowers",
    packageId = "brainstorming",
    sourcePath = "skills/brainstorming",
    skill = "# Previously materialized skill\n",
  }: {
    assetId?: string;
    packageId?: string;
    sourcePath?: string;
    skill?: string;
  } = {},
): Promise<void> {
  await mkdir(destinationPath, { recursive: true });
  await writeFile(join(destinationPath, "SKILL.md"), skill, "utf8");
  await writeFile(
    join(destinationPath, ".saber-package.json"),
    `${JSON.stringify({ schemaVersion: 1, assetId, packageId, sourcePath }, null, 2)}\n`,
    "utf8",
  );
}

async function writeManagedManifest(
  root: string,
  packages: readonly unknown[],
): Promise<void> {
  const manifestPath = join(root, ".saber/external/saber-v1/manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, managedBy: "saber", packages }, null, 2)}\n`,
    "utf8",
  );
}

test("checked-in external catalog lists the deliberately selected skill packages", async () => {
  const result = await runCli(["external", "list", "--json"], { cwd: repositoryRoot });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as {
    assets: Array<{
      id: string;
      category: string;
      selectedPackageCount: number;
      selectedPackages: Array<{ id: string; sourcePath: string }>;
    }>;
  };

  assert.deepEqual(
    output.assets.map((assetRecord) => ({
      id: assetRecord.id,
      category: assetRecord.category,
      selectedPackageCount: assetRecord.selectedPackageCount,
      selectedPackages: assetRecord.selectedPackages.map(({ id, sourcePath }) => ({
        id,
        sourcePath,
      })),
    })),
    [
      {
        id: "superpowers",
        category: "skill-collection",
        selectedPackageCount: 6,
        selectedPackages: [
          { id: "brainstorming", sourcePath: "skills/brainstorming" },
          { id: "writing-plans", sourcePath: "skills/writing-plans" },
          { id: "executing-plans", sourcePath: "skills/executing-plans" },
          { id: "systematic-debugging", sourcePath: "skills/systematic-debugging" },
          {
            id: "verification-before-completion",
            sourcePath: "skills/verification-before-completion",
          },
          { id: "requesting-code-review", sourcePath: "skills/requesting-code-review" },
        ],
      },
      {
        id: "openspec",
        category: "skill-collection",
        selectedPackageCount: 4,
        selectedPackages: [
          { id: "openspec-explore", sourcePath: "skills/openspec-explore" },
          { id: "openspec-propose", sourcePath: "skills/openspec-propose" },
          { id: "openspec-apply-change", sourcePath: "skills/openspec-apply-change" },
          { id: "openspec-archive-change", sourcePath: "skills/openspec-archive-change" },
        ],
      },
    ],
  );
});

test("external update defaults to a sparse cache plan and runs no commands", async () => {
  const root = await temporaryRepository("saber-external-dry-run-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const externalAssets = registry([
    asset({
      packages: [
        selectedPackage(),
        selectedPackage({ id: "writing-plans", sourcePath: "skills/writing-plans" }),
      ],
    }),
  ]);

  try {
    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.deepEqual(operations, [
      {
        assetId: "superpowers",
        category: "skill-collection",
        description: "团队可按需拉取的 Superpowers 技能集合。",
        sourceStatus: "configured",
        cache: ".saber/cache/saber-v1/superpowers",
        state: "missing",
        mode: "clone",
        commands: [
          {
            program: "git",
            args: [
              "-c",
              `core.hooksPath=${devNull}`,
              "clone",
              "--filter=blob:none",
              "--sparse",
              "https://github.com/example/superpowers.git",
              ".saber/cache/saber-v1/superpowers",
            ],
          },
          {
            program: "git",
            args: [
              "-C",
              ".saber/cache/saber-v1/superpowers",
              "remote",
              "get-url",
              "origin",
            ],
          },
          {
            program: "git",
            args: [
              "-c",
              `core.hooksPath=${devNull}`,
              "-C",
              ".saber/cache/saber-v1/superpowers",
              "sparse-checkout",
              "set",
              "--no-cone",
              "/skills/brainstorming/**",
              "/skills/writing-plans/**",
            ],
          },
          {
            program: "git",
            args: ["-C", ".saber/cache/saber-v1/superpowers", "rev-parse", "HEAD"],
          },
        ],
        selectedPackages: [
          {
            id: "brainstorming",
            sourcePath: "skills/brainstorming",
            destination: ".saber/external/saber-v1/skills/superpowers/brainstorming",
            state: "missing",
            mode: "materialize",
          },
          {
            id: "writing-plans",
            sourcePath: "skills/writing-plans",
            destination: ".saber/external/saber-v1/skills/superpowers/writing-plans",
            state: "missing",
            mode: "materialize",
          },
        ],
      },
    ]);

    const result = await runCli(["external", "update", "--json"], {
      cwd: root,
      dependencies: {
        externalCommand: {
          loadConfig: async () => configWith(externalAssets),
          runner: recordingRunner(commands),
        },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { mode: "dry-run", operations });
    assert.deepEqual(commands, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external update rejects apply without exact confirm and runs no command", async () => {
  const root = await temporaryRepository("saber-external-unconfirmed-");
  const commands: { program: string; args: readonly string[] }[] = [];

  try {
    const result = await runCli(
      ["external", "update", "superpowers", "--apply"],
      {
        cwd: root,
        dependencies: {
          externalCommand: {
            loadConfig: async () => configWith(registry([asset()])),
            runner: recordingRunner(commands),
          },
        },
      },
    );

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /--apply requires --confirm/u);
    assert.deepEqual(commands, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unmarked Git cache is a conflict and is never pulled or materialized", async () => {
  const root = await temporaryRepository("saber-external-unmanaged-cache-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.equal(operations[0]?.state, "conflict");
    assert.equal(operations[0]?.mode, "conflict");
    assert.deepEqual(operations[0]?.commands, []);
    assert.match(operations[0]?.recovery ?? "", /remove.*re-run external update/u);
    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: recordingRunner(commands),
        }),
      (error: unknown) =>
        error instanceof SaberError && /cache conflict.*remove.*re-run external update/u.test(error.message),
    );
    assert.deepEqual(commands, []);
    await assert.rejects(
      access(join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md")),
      { code: "ENOENT" },
    );
    await assert.rejects(access(join(root, ".saber/external/saber-v1/manifest.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a managed cache with a mismatched origin is rejected before pull or materialization", async () => {
  const root = await temporaryRepository("saber-external-origin-mismatch-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    await writeFile(
      join(cachePath, "skills/brainstorming/SKILL.md"),
      "# Unapproved cache\n",
      "utf8",
    );
    const operations = await planExternalAssetUpdates(root, externalAssets);

    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: async (command) => {
            commands.push(command);
            return {
              exitCode: 0,
              stdout: "https://evil.example/skills.git\n",
            };
          },
        }),
      (error: unknown) =>
        error instanceof SaberError && /cache origin does not match configured source/u.test(error.message),
    );
    assert.deepEqual(commands, [
      {
        program: "git",
        args: [
          "-C",
          join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
          "remote",
          "get-url",
          "origin",
        ],
      },
    ]);
    await assert.rejects(
      access(join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh clone with a mismatched origin is rejected before it is marked or materialized", async () => {
  const root = await temporaryRepository("saber-external-clone-origin-mismatch-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const externalAssets = registry([asset()]);

  try {
    const operations = await planExternalAssetUpdates(root, externalAssets);

    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: async (command) => {
            commands.push(command);
            if (command.args.includes("clone")) {
              const cachePath = command.args.at(-1);
              assert.ok(cachePath);
              await mkdir(join(cachePath, ".git"), { recursive: true });
              await writeCachedSkillPackage(cachePath, "skills/brainstorming");
            }
            return {
              exitCode: 0,
              stdout: command.args.includes("remote")
                ? "https://evil.example/skills.git\n"
                : "",
            };
          },
        }),
      (error: unknown) =>
        error instanceof SaberError && /cache origin does not match configured source/u.test(error.message),
    );
    assert.deepEqual(commands, [
      {
        program: "git",
        args: [
          "-c",
          `core.hooksPath=${devNull}`,
          "clone",
          "--filter=blob:none",
          "--sparse",
          "https://github.com/example/superpowers.git",
          join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
        ],
      },
      {
        program: "git",
        args: [
          "-C",
          join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
          "remote",
          "get-url",
          "origin",
        ],
      },
    ]);
    await assert.rejects(
      access(join(root, ".saber/cache/saber-v1/superpowers/.saber-cache.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      access(join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a selected package cannot be sourced through a cache symlink", async () => {
  const root = await temporaryRepository("saber-external-source-symlink-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await mkdir(join(cachePath, "skills"), { recursive: true });
    await writeCachedSkillPackage(cachePath, "different-package");
    await symlink(
      join(cachePath, "different-package"),
      join(cachePath, "skills/brainstorming"),
      "dir",
    );
    const operations = await planExternalAssetUpdates(root, externalAssets);

    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: recordingRunner(commands),
        }),
      (error: unknown) =>
        error instanceof SaberError && /managed path must not contain symbolic links/u.test(error.message),
    );
    await assert.rejects(
      access(join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cache with a symlink in its Git control area is a conflict and runs no Git command", async () => {
  const root = await temporaryRepository("saber-external-git-symlink-");
  const outside = await temporaryRepository("saber-external-git-symlink-outside-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    await symlink(outside, join(cachePath, ".git/objects"), "dir");

    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.equal(operations[0]?.state, "conflict");
    assert.equal(operations[0]?.mode, "conflict");
    assert.deepEqual(operations[0]?.commands, []);
    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: recordingRunner(commands),
        }),
      (error: unknown) =>
        error instanceof SaberError && /cache conflict.*remove.*re-run external update/u.test(error.message),
    );
    assert.deepEqual(commands, []);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("a Git control-area symlink introduced between commands blocks the next Git command", async () => {
  const root = await temporaryRepository("saber-external-git-symlink-race-");
  const outside = await temporaryRepository("saber-external-git-symlink-race-outside-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: recordingRunner(commands, async (command) => {
            if (command.args.includes("remote")) {
              await symlink(outside, join(cachePath, ".git/objects"), "dir");
            }
          }),
        }),
      (error: unknown) =>
        error instanceof SaberError && /Git control area.*re-clone/u.test(error.message),
    );
    assert.equal(commands.length, 1);
    assert.ok(commands[0]?.args.includes("remote"));
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("a nested symlink in a selected source subtree is rejected before materialization", async () => {
  const root = await temporaryRepository("saber-external-source-tree-symlink-");
  const outside = await temporaryRepository("saber-external-source-tree-symlink-outside-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    await symlink(
      outside,
      join(cachePath, "skills/brainstorming/references/untrusted-link"),
      "dir",
    );
    const operations = await planExternalAssetUpdates(root, externalAssets);

    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: recordingRunner(commands),
        }),
      (error: unknown) =>
        error instanceof SaberError && /selected package source tree contains an unsafe entry/u.test(error.message),
    );
    assert.deepEqual(
      commands,
      expectedManagedCacheUpdateCommands(
        join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
        ["skills/brainstorming"],
      ),
    );
    await assert.rejects(access(join(root, ".saber/external")), { code: "ENOENT" });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("an unmanaged external manifest is refused before any update side effect", async () => {
  const root = await temporaryRepository("saber-external-unmanaged-manifest-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const manifestPath = join(root, ".saber/external/saber-v1/manifest.json");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, "{\"owner\":\"human\"}\n", "utf8");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    await assert.rejects(
      () =>
        executeExternalAssetUpdates(root, externalAssets, operations, {
          runner: recordingRunner(commands),
        }),
      (error: unknown) =>
        error instanceof SaberError && /external manifest is not managed by Saber/u.test(error.message),
    );
    assert.deepEqual(commands, []);
    assert.equal(await readFile(manifestPath, "utf8"), "{\"owner\":\"human\"}\n");
    await assert.rejects(
      access(join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed update sparse-clones only the selected asset and materializes only its selected package", async () => {
  const root = await temporaryRepository("saber-external-clone-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const externalAssets = registry([
    asset(),
    asset({
      id: "openspec",
      description: "团队可按需拉取的 OpenSpec 规格工作流技能集合。",
      source: "https://github.com/example/openspec.git",
      packages: [selectedPackage({ id: "openspec-explore", sourcePath: "skills/openspec-explore" })],
    }),
  ]);

  try {
    const result = await runCli(
      ["external", "update", "superpowers", "--apply", "--confirm", "--json"],
      {
        cwd: root,
        dependencies: {
          externalCommand: {
            loadConfig: async () => configWith(externalAssets),
            runner: recordingRunner(commands, async (command) => {
              if (command.args.includes("clone")) {
                const cachePath = command.args.at(-1);
                assert.ok(cachePath);
                await mkdir(join(cachePath, ".git"), { recursive: true });
                await writeCachedSkillPackage(cachePath, "skills/brainstorming");
              }
            }),
          },
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).mode, "applied");
    assert.deepEqual(commands, [
      {
        program: "git",
        args: [
          "-c",
          `core.hooksPath=${devNull}`,
          "clone",
          "--filter=blob:none",
          "--sparse",
          "https://github.com/example/superpowers.git",
          join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
        ],
      },
      {
        program: "git",
        args: [
          "-C",
          join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
          "remote",
          "get-url",
          "origin",
        ],
      },
      {
        program: "git",
        args: [
          "-c",
          `core.hooksPath=${devNull}`,
          "-C",
          join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
          "sparse-checkout",
          "set",
          "--no-cone",
          "/skills/brainstorming/**",
        ],
      },
      {
        program: "git",
        args: [
          "-C",
          join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
          "rev-parse",
          "HEAD",
        ],
      },
    ]);
    assert.equal(
      await readFile(
        join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md"),
        "utf8",
      ),
      "# Selected skill\n",
    );
    assert.equal(
      await readFile(
        join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/references/guide.md"),
        "utf8",
      ),
      "guide\n",
    );
    await assert.rejects(access(join(root, ".saber/external/saber-v1/skills/openspec")), { code: "ENOENT" });
    await assert.rejects(access(join(root, ".saber/external/superpowers")), { code: "ENOENT" });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, ".saber/external/saber-v1/manifest.json"), "utf8")),
      {
        schemaVersion: 1,
        managedBy: "saber",
        packages: [
          {
            id: "superpowers/brainstorming",
            assetId: "superpowers",
            packageId: "brainstorming",
            category: "skill-collection",
            sourcePath: "skills/brainstorming",
            materializedPath: ".saber/external/saber-v1/skills/superpowers/brainstorming",
            revision: "0123456789abcdef",
          },
        ],
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saber-v1 updates leave legacy caches, manifest, and materialized skills untouched", async () => {
  const root = await temporaryRepository("saber-external-legacy-isolation-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const legacyCachePath = join(root, ".saber/cache/superpowers");
  const legacyManifestPath = join(root, ".saber/external/manifest.json");
  const legacySkillPath = join(root, ".saber/external/skills/superpowers/brainstorming/SKILL.md");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(legacyCachePath, ".git"), { recursive: true });
    await writeFile(join(legacyCachePath, "legacy-cache.txt"), "keep legacy cache\n", "utf8");
    await mkdir(dirname(legacyManifestPath), { recursive: true });
    await writeFile(legacyManifestPath, "{\"owner\":\"legacy\"}\n", "utf8");
    await mkdir(dirname(legacySkillPath), { recursive: true });
    await writeFile(legacySkillPath, "# Legacy skill\n", "utf8");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.equal(operations[0]?.mode, "clone");
    await executeExternalAssetUpdates(root, externalAssets, operations, {
      runner: recordingRunner(commands, async (command) => {
        if (command.args.includes("clone")) {
          const cachePath = command.args.at(-1);
          assert.ok(cachePath);
          await mkdir(join(cachePath, ".git"), { recursive: true });
          await writeCachedSkillPackage(cachePath, "skills/brainstorming");
        }
      }),
    });

    assert.ok(commands.every((command) => !command.args.includes(legacyCachePath)));
    assert.equal(await readFile(join(legacyCachePath, "legacy-cache.txt"), "utf8"), "keep legacy cache\n");
    assert.equal(await readFile(legacyManifestPath, "utf8"), "{\"owner\":\"legacy\"}\n");
    assert.equal(await readFile(legacySkillPath, "utf8"), "# Legacy skill\n");
    assert.equal(
      await readFile(
        join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md"),
        "utf8",
      ),
      "# Selected skill\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing sparse Git cache plans an origin-pinned ff-only pull and materializes selected package trees", async () => {
  const root = await temporaryRepository("saber-external-pull-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    await writeFile(join(cachePath, "CLAUDE.md"), "# Unselected root file\n", "utf8");
    await symlink("CLAUDE.md", join(cachePath, "AGENTS.md"), "file");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.equal(operations[0]?.mode, "pull");
    assert.deepEqual(
      operations[0]?.commands,
      expectedManagedCacheUpdateCommands(".saber/cache/saber-v1/superpowers", ["skills/brainstorming"]),
    );
    await executeExternalAssetUpdates(root, externalAssets, operations, {
      runner: recordingRunner(commands),
    });

    assert.deepEqual(
      commands,
      expectedManagedCacheUpdateCommands(
        join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
        ["skills/brainstorming"],
      ),
    );
    assert.equal(
      await readFile(
        join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming/SKILL.md"),
        "utf8",
      ),
      "# Selected skill\n",
    );
    await assert.rejects(
      access(join(root, ".saber/external/saber-v1/skills/superpowers/AGENTS.md")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updating a marked package replaces its tree and removes stale files", async () => {
  const root = await temporaryRepository("saber-external-replace-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const destinationPath = join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    await writeFile(join(cachePath, "skills/brainstorming/SKILL.md"), "# Fresh skill\n", "utf8");
    await writeFile(join(cachePath, "skills/brainstorming/fresh.md"), "fresh\n", "utf8");
    await writeManagedSkillPackage(destinationPath);
    await writeFile(join(destinationPath, "stale.md"), "stale\n", "utf8");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.equal(operations[0]?.selectedPackages[0]?.state, "managed");
    await executeExternalAssetUpdates(root, externalAssets, operations, {
      runner: recordingRunner(commands),
    });

    assert.equal(await readFile(join(destinationPath, "SKILL.md"), "utf8"), "# Fresh skill\n");
    assert.equal(await readFile(join(destinationPath, "fresh.md"), "utf8"), "fresh\n");
    await assert.rejects(access(join(destinationPath, "stale.md")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selective updates preserve revisions for unselected managed packages", async () => {
  const root = await temporaryRepository("saber-external-manifest-revisions-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const superpowers = asset();
  const openspec = asset({
    id: "openspec",
    description: "团队可按需拉取的 OpenSpec 规格工作流技能集合。",
    source: "https://github.com/example/openspec.git",
    packages: [selectedPackage({ id: "openspec-explore", sourcePath: "skills/openspec-explore" })],
  });
  const externalAssets = registry([superpowers, openspec]);
  const superpowersCache = join(root, ".saber/cache/saber-v1/superpowers");
  const openspecCache = join(root, ".saber/cache/saber-v1/openspec");

  try {
    await mkdir(join(superpowersCache, ".git"), { recursive: true });
    await writeManagedCacheMarker(superpowersCache);
    await writeCachedSkillPackage(superpowersCache, "skills/brainstorming");
    await mkdir(join(openspecCache, ".git"), { recursive: true });
    await writeManagedCacheMarker(openspecCache, {
      assetId: "openspec",
      source: "https://github.com/example/openspec.git",
    });
    await writeCachedSkillPackage(openspecCache, "skills/openspec-explore");
    await writeManagedSkillPackage(
      join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming"),
    );
    await writeManagedSkillPackage(
      join(root, ".saber/external/saber-v1/skills/openspec/openspec-explore"),
      {
        assetId: "openspec",
        packageId: "openspec-explore",
        sourcePath: "skills/openspec-explore",
      },
    );
    await writeManagedManifest(root, [
      {
        id: "superpowers/brainstorming",
        assetId: "superpowers",
        packageId: "brainstorming",
        category: "skill-collection",
        sourcePath: "skills/brainstorming",
        materializedPath: ".saber/external/saber-v1/skills/superpowers/brainstorming",
        revision: "old-superpowers-revision",
      },
      {
        id: "openspec/openspec-explore",
        assetId: "openspec",
        packageId: "openspec-explore",
        category: "skill-collection",
        sourcePath: "skills/openspec-explore",
        materializedPath: ".saber/external/saber-v1/skills/openspec/openspec-explore",
        revision: "keep-openspec-revision",
      },
    ]);
    const operations = await planExternalAssetUpdates(root, externalAssets, "superpowers");

    await executeExternalAssetUpdates(root, externalAssets, operations, {
      runner: recordingRunner(commands),
    });

    const manifest = JSON.parse(
      await readFile(join(root, ".saber/external/saber-v1/manifest.json"), "utf8"),
    ) as { packages: Array<{ id: string; revision: string | null }> };
    assert.deepEqual(manifest.packages.map(({ id, revision }) => ({ id, revision })), [
      { id: "openspec/openspec-explore", revision: "keep-openspec-revision" },
      { id: "superpowers/brainstorming", revision: "0123456789abcdef" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing unmanaged visible package is a conflict and is never overwritten", async () => {
  const root = await temporaryRepository("saber-external-conflict-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/superpowers");
  const visiblePackage = join(root, ".saber/external/saber-v1/skills/superpowers/brainstorming");
  const externalAssets = registry([asset()]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath);
    await writeCachedSkillPackage(cachePath, "skills/brainstorming");
    await mkdir(visiblePackage, { recursive: true });
    await writeFile(join(visiblePackage, "keep.txt"), "keep", "utf8");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.equal(operations[0]?.selectedPackages[0]?.state, "conflict");
    assert.equal(operations[0]?.selectedPackages[0]?.mode, "conflict");
    await executeExternalAssetUpdates(root, externalAssets, operations, {
      runner: recordingRunner(commands),
    });

    assert.equal(await readFile(join(visiblePackage, "keep.txt"), "utf8"), "keep");
    assert.deepEqual(
      commands,
      expectedManagedCacheUpdateCommands(
        join(await realpath(root), ".saber/cache/saber-v1/superpowers"),
        ["skills/brainstorming"],
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a future MCP asset uses a safe generic subtree and a separate materialized MCP layout", async () => {
  const root = await temporaryRepository("saber-external-mcp-");
  const commands: { program: string; args: readonly string[] }[] = [];
  const cachePath = join(root, ".saber/cache/saber-v1/idea-mcp");
  const externalAssets = registry([
    asset({
      id: "idea-mcp",
      category: "mcp-server",
      description: "团队可按需拉取的 IdeaMCP 服务包。",
      source: "https://github.com/example/idea-mcp.git",
      packages: [{ id: "idea-server", sourcePath: "servers/idea" }],
    }),
  ]);

  try {
    await mkdir(join(cachePath, ".git"), { recursive: true });
    await writeManagedCacheMarker(cachePath, {
      assetId: "idea-mcp",
      source: "https://github.com/example/idea-mcp.git",
    });
    await mkdir(join(cachePath, "servers/idea"), { recursive: true });
    await writeFile(join(cachePath, "servers/idea", "server.json"), "{}\n", "utf8");
    const operations = await planExternalAssetUpdates(root, externalAssets);

    assert.equal(operations[0]?.selectedPackages[0]?.destination, ".saber/external/saber-v1/mcp/idea-mcp/idea-server");
    await executeExternalAssetUpdates(root, externalAssets, operations, {
      runner: recordingRunner(
        commands,
        undefined,
        "https://github.com/example/idea-mcp.git",
      ),
    });

    assert.equal(
      await readFile(join(root, ".saber/external/saber-v1/mcp/idea-mcp/idea-server/server.json"), "utf8"),
      "{}\n",
    );
    const manifest = JSON.parse(await readFile(join(root, ".saber/external/saber-v1/manifest.json"), "utf8")) as {
      packages: Array<{ id: string; category: string; materializedPath: string }>;
    };
    assert.deepEqual(manifest.packages.map(({ id, category, materializedPath }) => ({
      id,
      category,
      materializedPath,
    })), [
      {
        id: "idea-mcp/idea-server",
        category: "mcp-server",
        materializedPath: ".saber/external/saber-v1/mcp/idea-mcp/idea-server",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external asset planning rejects unsafe ids, package paths, and symlink escapes", async () => {
  const root = await temporaryRepository("saber-external-unsafe-");
  const outside = await temporaryRepository("saber-external-outside-");

  try {
    await assert.rejects(
      () => planExternalAssetUpdates(root, registry([asset({ id: "../not-an-id" })])),
      (error: unknown) => error instanceof SaberError && /invalid external asset id/u.test(error.message),
    );
    await assert.rejects(
      () =>
        planExternalAssetUpdates(
          root,
          registry([asset({ packages: [selectedPackage({ sourcePath: "../outside" })] })]),
        ),
      (error: unknown) =>
        error instanceof SaberError && /invalid external skill package path/u.test(error.message),
    );

    await mkdir(join(root, ".saber"));
    await symlink(outside, join(root, ".saber/cache"), "dir");
    await assert.rejects(
      () => planExternalAssetUpdates(root, registry([asset()])),
      (error: unknown) =>
        error instanceof SaberError &&
        /(escapes repository root|managed path must not contain symbolic links)/u.test(error.message),
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("external asset planning rejects descriptions that could alter terminal output", async () => {
  const root = await temporaryRepository("saber-external-description-");

  try {
    for (const description of ["可信描述\n\u001b[2J", "可信描述\u202e"]) {
      await assert.rejects(
        () => planExternalAssetUpdates(root, registry([asset({ description })])),
        (error: unknown) =>
          error instanceof SaberError && /description must be a single safe line/u.test(error.message),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external updates reject control characters in Git sources before any clone argv is constructed", async () => {
  const root = await temporaryRepository("saber-external-source-controls-");

  try {
    for (const source of [
      "https://github.com/example/superpowers.git\n--upload-pack=evil",
      "https://github.com/example/superpowers.git\r--upload-pack=evil",
      "https://github.com/example/\u001bsuperpowers.git",
      "https://github.com/example/\u202esuperpowers.git",
      "https://github.com/example/\u2028superpowers.git",
      "https://github.com/example/\u2029superpowers.git",
    ]) {
      const commands: { program: string; args: readonly string[] }[] = [];
      const result = await runCli(
        ["external", "update", "superpowers", "--apply", "--confirm", "--json"],
        {
          cwd: root,
          dependencies: {
            externalCommand: {
              loadConfig: async () => configWith(registry([asset({ source })])),
              runner: recordingRunner(commands),
            },
          },
        },
      );

      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /source must be a safe Git remote/u);
      assert.deepEqual(commands, []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external source validation keeps standard public HTTPS and SCP remotes", () => {
  assert.equal(
    isSafeExternalAssetSource("https://github.com/obra/superpowers.git"),
    true,
  );
  assert.equal(
    isSafeExternalAssetSource("git@github.com:obra/superpowers.git"),
    true,
  );
});

test("external asset planning rejects an in-repository symlinked managed root", async () => {
  const root = await temporaryRepository("saber-external-internal-symlink-");

  try {
    await mkdir(join(root, ".saber"));
    await mkdir(join(root, "relocated-external"));
    await symlink(
      join(root, "relocated-external"),
      join(root, ".saber/external"),
      "dir",
    );

    await assert.rejects(
      () => planExternalAssetUpdates(root, registry([asset()])),
      (error: unknown) =>
        error instanceof SaberError && /managed path must not contain symbolic links/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external source previews redact URL authority userinfo", () => {
  assert.equal(
    redactExternalAssetSource("https://token:secret@example.test/team/asset.git?access=secret#fragment"),
    "https://example.test/team/asset.git",
  );
  assert.equal(
    redactExternalAssetSource("personal-user@git.example.test:team/asset.git"),
    "ssh://git.example.test/team/asset.git",
  );
});

test("external command rejects unknown flags, malformed syntax, and unknown asset ids", async () => {
  for (const argv of [
    ["external", "list", "--verbose"],
    ["external", "update", "superpowers", "openspec"],
    ["external", "update", "not-registered"],
    ["external", "update", "superpowers", "--confirm=false"],
  ]) {
    const result = await runCli(argv, { cwd: repositoryRoot });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(result.stdout, "");
  }
});

test("configuration requires selected packages, safe source paths, and credential-free Git sources", async () => {
  const root = await temporaryRepository("saber-external-registry-validation-");
  const source = await readFile(join(repositoryRoot, "saber.yaml"), "utf8");
  const invalidCatalogs = [
    source.replace("category: skill-collection", "category: unsupported"),
    source.replace("source: https://github.com/obra/superpowers.git", "source: --config=unsafe"),
    source.replace(
      "source: https://github.com/obra/superpowers.git",
      "source: https://token:secret@example.test/superpowers.git",
    ),
    source.replace("sourcePath: skills/brainstorming", "sourcePath: ../all-skills"),
  ];

  try {
    for (const invalid of invalidCatalogs) {
      await writeFile(join(root, "saber.yaml"), invalid, "utf8");
      await assert.rejects(() => loadRepositoryConfig(root), SaberError);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
