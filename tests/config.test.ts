import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRepositoryConfig } from "../src/lib/config.js";
import { SaberError } from "../src/lib/errors.js";
import { readTextWithinRoot, resolveWithinRoot } from "../src/lib/files.js";
import { validateRepositoryConfig } from "../src/lib/validation.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("validateRepositoryConfig rejects a configured L3 capability", () => {
  const errors = validateRepositoryConfig({
    workspace: { schemaVersion: 1, tools: { default: "codex" }, projects: [] },
    capabilities: [{ id: "git.force-push", risk: "L3", kind: "action" }],
    connectors: [],
  });

  assert.deepEqual(errors, ["capability git.force-push uses forbidden risk level L3"]);
});

test("validateRepositoryConfig accepts all three supported tools", () => {
  const errors = validateRepositoryConfig({
    workspace: {
      schemaVersion: 1,
      tools: { default: "codex", supported: ["codex", "claude", "opencode"] },
      projects: [],
    },
    capabilities: [],
    connectors: [],
  });

  assert.deepEqual(errors, []);
});

test("validateRepositoryConfig rejects a default tool missing from a non-empty supported list", () => {
  const errors = validateRepositoryConfig({
    workspace: {
      schemaVersion: 1,
      tools: { default: "codex", supported: ["claude"] },
      projects: [],
    },
    capabilities: [],
    connectors: [],
  });

  assert.deepEqual(errors, ["default tool codex is not included in supported tools"]);
});

test("validateRepositoryConfig identifies cross-file configuration errors", () => {
  const errors = validateRepositoryConfig({
    workspace: {
      schemaVersion: 1,
      tools: { default: "unknown-tool" as "codex" },
      projects: [
        { name: "frontend", path: "../frontend" },
        { name: "frontend", path: "projects/frontend" },
      ],
    },
    capabilities: [
      { id: "jira.update", risk: "L2", kind: "action", connector: "missing" },
      { id: "jira.update", risk: "L2", kind: "action" },
    ],
    connectors: [
      { id: "jira", kind: "http", requiredEnv: ["jira_token"], provides: [] },
    ],
  });

  assert.deepEqual(errors, [
    "unknown tool unknown-tool",
    "project frontend has unsafe path ../frontend",
    "duplicate project name frontend",
    "duplicate capability id jira.update",
    "capability jira.update references missing connector missing",
    "connector jira has invalid environment variable name jira_token",
  ]);
});

test("validateRepositoryConfig requires connector and capability mappings to agree both ways", () => {
  const errors = validateRepositoryConfig({
    workspace: { schemaVersion: 1, tools: { default: "codex" }, projects: [] },
    capabilities: [
      { id: "jira.read", risk: "L0", kind: "read", connector: "jira" },
      { id: "external.assets.update", risk: "L1", kind: "action" },
    ],
    connectors: [
      { id: "jira", kind: "http", requiredEnv: ["JIRA_TOKEN"], provides: [] },
      {
        id: "gitlab",
        kind: "http",
        requiredEnv: ["GITLAB_TOKEN"],
        provides: ["jira.read", "jira.read", "external.assets.update"],
      },
    ],
  });

  assert.deepEqual(errors, [
    "capability jira.read is not provided by connector jira",
    "connector gitlab repeats provided capability jira.read",
    "connector gitlab provides capability jira.read mapped to connector jira",
    "connector gitlab provides connectorless capability external.assets.update",
  ]);
});

test("validateRepositoryConfig accepts a mutually consistent connector capability mapping", () => {
  const errors = validateRepositoryConfig({
    workspace: { schemaVersion: 1, tools: { default: "codex" }, projects: [] },
    capabilities: [{ id: "jira.read", risk: "L0", kind: "read", connector: "jira" }],
    connectors: [
      {
        id: "jira",
        kind: "http",
        requiredEnv: ["JIRA_TOKEN"],
        provides: ["jira.read"],
      },
    ],
  });

  assert.deepEqual(errors, []);
});

test("resolveWithinRoot rejects paths escaping the repository root", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "saber-path-root-"));
  const repositoryRoot = join(temporaryDirectory, "repository");

  await mkdir(repositoryRoot);

  try {
    assert.equal(
      resolveWithinRoot(repositoryRoot, "mcp/capabilities.yaml"),
      join(await realpath(repositoryRoot), "mcp", "capabilities.yaml"),
    );

    assert.throws(
      () => resolveWithinRoot(repositoryRoot, "../outside.yaml"),
      (error: unknown) => error instanceof SaberError && /escapes repository root/.test(error.message),
    );
    assert.throws(
      () => resolveWithinRoot(repositoryRoot, "C:\\outside.yaml"),
      (error: unknown) => error instanceof SaberError && /escapes repository root/.test(error.message),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("resolveWithinRoot rejects an escaping intermediate symlink for a new file", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "saber-path-symlink-"));
  const repositoryRoot = join(temporaryDirectory, "repository");
  const externalDirectory = join(temporaryDirectory, "external");

  try {
    await mkdir(repositoryRoot);
    await mkdir(externalDirectory);
    await symlink(externalDirectory, join(repositoryRoot, "linked"), "dir");

    assert.equal(
      resolveWithinRoot(repositoryRoot, "new-file.yaml"),
      join(await realpath(repositoryRoot), "new-file.yaml"),
    );
    assert.throws(
      () => resolveWithinRoot(repositoryRoot, "linked/new-file.yaml"),
      (error: unknown) => error instanceof SaberError && /escapes repository root/.test(error.message),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("readTextWithinRoot rejects a symlink whose real target escapes the repository root", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "saber-root-boundary-"));
  const repositoryRoot = join(temporaryDirectory, "repository");
  const externalFile = join(temporaryDirectory, "external.yaml");

  try {
    await mkdir(repositoryRoot);
    await writeFile(join(repositoryRoot, "inside.yaml"), "inside: true\n", "utf8");
    await writeFile(externalFile, "outside: true\n", "utf8");
    await symlink(externalFile, join(repositoryRoot, "escape.yaml"), "file");

    assert.equal(await readTextWithinRoot(repositoryRoot, "inside.yaml"), "inside: true\n");
    await assert.rejects(
      () => readTextWithinRoot(repositoryRoot, "escape.yaml"),
      (error: unknown) =>
        error instanceof SaberError && /escapes repository root/.test(error.message),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("loadRepositoryConfig hard-limits the MVP forbidden risk policy to L3", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "saber-safety-policy-"));

  try {
    const source = await readFile(join(projectRoot, "saber.yaml"), "utf8");
    const invalidPolicy = source.replace("    - L3\n", "    - L2\n");
    assert.notEqual(invalidPolicy, source);
    await writeFile(join(temporaryDirectory, "saber.yaml"), invalidPolicy, "utf8");

    await assert.rejects(
      () => loadRepositoryConfig(temporaryDirectory),
      (error: unknown) =>
        error instanceof SaberError && /forbiddenRiskLevels must be exactly \[L3\]/.test(error.message),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("loadRepositoryConfig rejects unknown keys in every schema mapping", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "saber-unknown-config-key-"));

  try {
    const source = await readFile(join(projectRoot, "saber.yaml"), "utf8");
    const invalidConfigs = [
      `${source}token: ignored\n`,
      source.replace("safety:\n", "safety:\n  token: ignored\n"),
      source.replace("workspace:\n", "workspace:\n  token: ignored\n"),
      source.replace("  tools:\n", "  tools:\n    token: ignored\n"),
      source.replace("    - name: frontend\n", "    - token: ignored\n      name: frontend\n"),
      source.replace("  - id: jira.read\n", "  - token: ignored\n    id: jira.read\n"),
      source.replace("  - id: idea-mcp\n", "  - token: ignored\n    id: idea-mcp\n"),
      source.replace("externalAssets:\n", "externalAssets:\n  token: ignored\n"),
      source.replace("    - id: superpowers\n", "    - token: ignored\n      id: superpowers\n"),
      source.replace(
        "        - id: brainstorming\n",
        "        - token: ignored\n          id: brainstorming\n",
      ),
    ];

    for (const invalid of invalidConfigs) {
      assert.notEqual(invalid, source);
      await writeFile(join(temporaryDirectory, "saber.yaml"), invalid, "utf8");
      await assert.rejects(
        () => loadRepositoryConfig(temporaryDirectory),
        (error: unknown) => error instanceof SaberError && /unknown key/.test(error.message),
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
