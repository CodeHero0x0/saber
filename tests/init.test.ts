import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { devNull } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import type { SafeProcessCommand, SafeProcessRunner } from "../src/lib/git.js";
import type { RepositoryConfig } from "../src/lib/models.js";

function configWithProject(
  project: RepositoryConfig["workspace"]["projects"][number],
): RepositoryConfig {
  return {
    saber: {
      schemaVersion: 1,
      name: "Saber init test",
      safety: { externalWrites: "preview-and-confirm", forbiddenRiskLevels: ["L3"] },
    },
    workspace: { schemaVersion: 1, tools: { default: "codex" }, projects: [project] },
    capabilities: [],
    connectors: [],
    externalAssets: { schemaVersion: 1, assets: [] },
  };
}

function runnerRecording(calls: SafeProcessCommand[]): SafeProcessRunner {
  return async (command) => {
    calls.push(command);
    return { exitCode: 0 };
  };
}

test("init plans a missing project without invoking a runner by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-init-plan-"));
  const calls: SafeProcessCommand[] = [];
  const config = configWithProject({
    name: "frontend",
    path: "projects/frontend",
    repository: "https://git.example.test/team/frontend.git",
  });

  try {
    const result = await runCli(["init", "--json"], {
      cwd: root,
      dependencies: {
        initCommand: { loadConfig: async () => config, runner: runnerRecording(calls) },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      mode: "dry-run",
      valid: true,
      errors: [],
      projects: [
        {
          name: "frontend",
          path: "projects/frontend",
          state: "missing",
          action: "clone",
          repository: "https://git.example.test/team/frontend.git",
        },
      ],
    });
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init apply confirm invokes exactly one explicit clone for a missing configured project", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-init-apply-"));
  const calls: SafeProcessCommand[] = [];
  const config = configWithProject({
    name: "frontend",
    path: "projects/frontend",
    repository: "https://git.example.test/team/frontend.git",
  });

  try {
    const result = await runCli(["init", "--apply", "--confirm", "--json"], {
      cwd: root,
      dependencies: {
        initCommand: { loadConfig: async () => config, runner: runnerRecording(calls) },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal((JSON.parse(result.stdout) as { mode: string }).mode, "applied");
    assert.deepEqual(calls, [
      {
        program: "git",
        args: [
          "-c",
          `core.hooksPath=${devNull}`,
          "clone",
          "--",
          "https://git.example.test/team/frontend.git",
          join(await realpath(root), "projects", "frontend"),
        ],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init never overwrites an existing non-Git directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-init-existing-"));
  const calls: SafeProcessCommand[] = [];
  const config = configWithProject({
    name: "frontend",
    path: "projects/frontend",
    repository: "https://git.example.test/team/frontend.git",
  });
  await mkdir(join(root, "projects", "frontend"), { recursive: true });

  try {
    const result = await runCli(["init", "--apply", "--confirm", "--json"], {
      cwd: root,
      dependencies: {
        initCommand: { loadConfig: async () => config, runner: runnerRecording(calls) },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual((JSON.parse(result.stdout) as { projects: unknown[] }).projects, [
      {
        name: "frontend",
        path: "projects/frontend",
        state: "existing",
        action: "skip",
        repository: "https://git.example.test/team/frontend.git",
      },
    ]);
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init rejects an unconfirmed apply before invoking its runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-init-unconfirmed-"));
  const calls: SafeProcessCommand[] = [];
  const config = configWithProject({
    name: "frontend",
    path: "projects/frontend",
    repository: "https://git.example.test/team/frontend.git",
  });

  try {
    const result = await runCli(["init", "--apply"], {
      cwd: root,
      dependencies: {
        initCommand: { loadConfig: async () => config, runner: runnerRecording(calls) },
      },
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /--apply requires --confirm/u);
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init rejects unsafe project sources and symlinked path components without cloning", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-init-safety-"));
  const outside = await mkdtemp(join(tmpdir(), "saber-init-outside-"));
  const calls: SafeProcessCommand[] = [];

  try {
    const unsafeSource = await runCli(["init", "--apply", "--confirm"], {
      cwd: root,
      dependencies: {
        initCommand: {
          loadConfig: async () =>
            configWithProject({
              name: "frontend",
              path: "projects/frontend",
              repository: "http://unsafe.example.test/frontend.git",
            }),
          runner: runnerRecording(calls),
        },
      },
    });
    assert.equal(unsafeSource.exitCode, 2);
    assert.match(unsafeSource.stdout, /unsafe repository/u);
    assert.deepEqual(calls, []);

    await symlink(outside, join(root, "projects"), "dir");
    const symlinkedDestination = await runCli(["init", "--apply", "--confirm"], {
      cwd: root,
      dependencies: {
        initCommand: {
          loadConfig: async () =>
            configWithProject({
              name: "frontend",
              path: "projects/frontend",
              repository: "https://git.example.test/team/frontend.git",
            }),
          runner: runnerRecording(calls),
        },
      },
    });
    assert.equal(symlinkedDestination.exitCode, 2);
    assert.match(symlinkedDestination.stderr, /symbolic link/u);
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
