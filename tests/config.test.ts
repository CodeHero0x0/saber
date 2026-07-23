import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRepositoryConfig } from "../src/lib/config.js";
import { SaberError } from "../src/lib/errors.js";
import { readTextWithinRoot, resolveWithinRoot } from "../src/lib/files.js";
import { createStandardPreset } from "../src/lib/presets.js";
import { validateRepositoryConfig } from "../src/lib/validation.js";

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

const retiredConfig = `schemaVersion: 1
name: Legacy
safety:
  externalWrites: preview-and-confirm
  forbiddenRiskLevels: [L3]
workspace:
  tools:
    default: codex
  projects: []
capabilities: []
connectors: []
externalAssets:
  assets: []
roleProfiles: []
`;

const v3Config = `schemaVersion: 3
name: Example Team
workspace:
  tools:
    default: claude
  projects:
    - name: app
      path: projects/app
      capabilities: [jira.read]
externalSkills:
  preset: standard
`;

test("loadRepositoryConfig rejects retired schema versions without a compatibility path", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-v1-config-"));
  try {
    await writeFile(join(root, "saber.yaml"), retiredConfig, "utf8");
    await assert.rejects(
      () => loadRepositoryConfig(root),
      (error: unknown) => error instanceof SaberError && /schemaVersion must be 3/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standard preset returns fresh structures and schema v3 expands it", async () => {
  const first = createStandardPreset();
  first.capabilities[0]!.id = "changed";
  assert.equal(createStandardPreset().capabilities[0]!.id, "jira.read");

  const root = await mkdtemp(join(tmpdir(), "saber-v3-config-"));
  try {
    await writeFile(join(root, "saber.yaml"), v3Config, "utf8");
    const config = await loadRepositoryConfig(root);
    assert.equal(config.saber.name, "Example Team");
    assert.equal(config.workspace.tools.default, "claude");
    assert.deepEqual(config.workspace.tools.supported, ["codex", "claude", "opencode"]);
    assert.deepEqual(config.workspace.projects, [
      { name: "app", path: "projects/app", capabilities: ["jira.read"] },
    ]);
    assert.ok(config.capabilities.some((capability) => capability.id === "git.push"));
    assert.deepEqual(config.roleProfiles.map((profile) => profile.id), ["ba", "dev", "qa"]);
    assert.deepEqual(config.externalAssets.assets.map((asset) => asset.id), ["superpowers", "openspec"]);
    assert.deepEqual(config.local, {
      schemaVersion: 2,
      defaults: {},
      projects: {},
      extensions: { skills: [], prompts: [], capabilities: [], mcpServers: [] },
      mcp: { servers: [] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v3 rejects unknown keys in every team mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-v3-unknown-key-"));
  try {
    const invalidConfigs = [
      `${v3Config}token: ignored\n`,
      v3Config.replace("workspace:\n", "workspace:\n  token: ignored\n"),
      v3Config.replace("  tools:\n", "  tools:\n    token: ignored\n"),
      v3Config.replace("    - name: app\n", "    - token: ignored\n      name: app\n"),
      v3Config.replace("  preset: standard\n", "  preset: standard\n  token: ignored\n"),
    ];
    for (const source of invalidConfigs) {
      await writeFile(join(root, "saber.yaml"), source, "utf8");
      await assert.rejects(
        () => loadRepositoryConfig(root),
        (error: unknown) => error instanceof SaberError && /unknown key/u.test(error.message),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v3 applies restricted schema v2 local defaults, repository, and extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-local-config-"));
  try {
    await writeFile(join(root, "saber.yaml"), v3Config, "utf8");
    await writeFile(
      join(root, "saber.local.yaml"),
      `schemaVersion: 2
defaults:
  tool: opencode
projects:
  app:
    repository: git@example.test:team/app.git
extensions:
  skills: [personal-review]
  prompts: [concise-review]
  capabilities: [mysql.read, external.assets.update]
`,
      "utf8",
    );
    const config = await loadRepositoryConfig(root);
    assert.equal(config.workspace.tools.default, "opencode");
    assert.equal(config.workspace.projects[0]?.repository, "git@example.test:team/app.git");
    assert.deepEqual(config.workspace.tools.defaultCapabilities, [
      "jira.read",
      "gitlab.mr.read",
      "idea.project.read",
    ]);
    assert.deepEqual(config.local?.defaults, { tool: "opencode" });
    assert.deepEqual(config.local?.extensions, {
      skills: ["personal-review"],
      prompts: ["concise-review"],
      capabilities: ["mysql.read", "external.assets.update"],
      mcpServers: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local config rejects unknown projects, unsafe extensions, unknown keys, and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-local-invalid-"));
  const outside = join(root, "outside.yaml");
  try {
    await writeFile(join(root, "saber.yaml"), v3Config, "utf8");
    const invalidCases = [
      "schemaVersion: 2\nprojects:\n  other:\n    repository: https://example.test/other.git\n",
      "schemaVersion: 2\nextensions:\n  capabilities: [git.push]\n",
      "schemaVersion: 2\nextensions:\n  capabilities: [new.read]\n",
      "schemaVersion: 2\ndefaults:\n  token: do-not-print\n",
    ];
    for (const source of invalidCases) {
      await writeFile(join(root, "saber.local.yaml"), source, "utf8");
      await assert.rejects(() => loadRepositoryConfig(root), SaberError);
    }

    await rm(join(root, "saber.local.yaml"));
    await writeFile(outside, "schemaVersion: 2\n", "utf8");
    await symlink(outside, join(root, "saber.local.yaml"), "file");
    await assert.rejects(
      () => loadRepositoryConfig(root),
      (error: unknown) => error instanceof SaberError && /symbolic link/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local config rejects unsafe repositories without echoing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-local-secret-"));
  const secret = "super-secret-token";
  try {
    await writeFile(join(root, "saber.yaml"), v3Config, "utf8");
    await writeFile(
      join(root, "saber.local.yaml"),
      `schemaVersion: 2\nprojects:\n  app:\n    repository: https://user:${secret}@example.test/app.git\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadRepositoryConfig(root),
      (error: unknown) =>
        error instanceof SaberError &&
        /safe Git remote/u.test(error.message) &&
        !error.message.includes(secret),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
