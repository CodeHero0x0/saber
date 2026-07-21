import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { runCli } from "../src/cli.js";
import {
  appendWorkitemHandoff,
  createWorkitem,
  type WorkitemRepositoryReference,
} from "../src/lib/workitems.js";
import { SaberError } from "../src/lib/errors.js";
import type { RepositoryConfig } from "../src/lib/models.js";

const jiraUrl = "https://jira.example.test/browse/PROJ-123";
const fingerprint = "sha256:0123456789abcdef";

const repositories: WorkitemRepositoryReference[] = [
  {
    name: "frontend",
    path: "projects/frontend",
    repository: "https://git.example.test/team/frontend.git",
  },
  {
    name: "backend",
    path: "projects/backend",
    repository: "https://git.example.test/team/backend.git",
  },
];

function configWithProjects(
  projects: RepositoryConfig["workspace"]["projects"],
): RepositoryConfig {
  return {
    saber: {
      schemaVersion: 1,
      name: "Saber workitem test",
      safety: { externalWrites: "preview-and-confirm", forbiddenRiskLevels: ["L3"] },
    },
    workspace: { schemaVersion: 1, tools: { default: "codex" }, projects },
    capabilities: [],
    connectors: [],
    externalAssets: { schemaVersion: 1, assets: [] },
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "saber-workitem-"));
}

test("workitem create writes the complete cross-repository evidence pack", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, {
      key: "PROJ-123",
      jiraUrl,
      fingerprint,
      repositories,
    });

    const workitemRoot = join(root, "workitems", "PROJ-123");
    assert.deepEqual((await readdir(workitemRoot)).sort(), [
      "decisions",
      "design.md",
      "handoffs",
      "plan.md",
      "repositories.yaml",
      "requirements.md",
      "tests.md",
      "workitem.yaml",
    ]);
    for (const file of [
      "workitem.yaml",
      "requirements.md",
      "design.md",
      "plan.md",
      "tests.md",
      "repositories.yaml",
      "handoffs/README.md",
      "decisions/README.md",
    ]) {
      await access(join(workitemRoot, file));
    }

    assert.deepEqual(parse(await readFile(join(workitemRoot, "workitem.yaml"), "utf8")), {
      schemaVersion: 1,
      key: "PROJ-123",
      jira: { url: jiraUrl, fingerprint },
      repositories,
    });
    const repositoryEvidence = await readFile(join(workitemRoot, "repositories.yaml"), "utf8");
    assert.match(repositoryEvidence, /frontend/u);
    assert.match(repositoryEvidence, /backend/u);
    assert.match(await readFile(join(workitemRoot, "requirements.md"), "utf8"), /Acceptance/u);
    assert.match(await readFile(join(workitemRoot, "design.md"), "utf8"), /Interface/u);
    assert.match(await readFile(join(workitemRoot, "plan.md"), "utf8"), /Verification/u);
    assert.match(await readFile(join(workitemRoot, "tests.md"), "utf8"), /Evidence/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem creation refuses a duplicate or an unsafe key without writing outside workitems", async () => {
  const root = await temporaryRoot();

  try {
    const input = { key: "PROJ-123", jiraUrl, fingerprint, repositories };
    await createWorkitem(root, input);

    await assert.rejects(
      () => createWorkitem(root, input),
      (error: unknown) =>
        error instanceof SaberError && error.exitCode === 2 && /already exists/u.test(error.message),
    );
    await assert.rejects(
      () => createWorkitem(root, { ...input, key: "../outside" }),
      (error: unknown) =>
        error instanceof SaberError && error.exitCode === 2 && /invalid workitem key/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem handoff appends a timestamped role record rather than chat history", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    const record = await appendWorkitemHandoff(root, {
      key: "PROJ-123",
      role: "dev",
      summary: "Implemented the shared API contract.",
      risk: "Backend migration remains pending.",
      next: "QA verifies both repositories.",
      now: new Date("2026-07-22T08:30:45.123Z"),
    });

    assert.equal(record.path, "handoffs/2026-07-22T08-30-45.123Z-dev.md");
    const content = await readFile(join(root, "workitems", "PROJ-123", record.path), "utf8");
    assert.match(content, /# Handoff — PROJ-123/u);
    assert.match(content, /From role: `dev`/u);
    assert.match(content, /Implemented the shared API contract\./u);
    assert.match(content, /Backend migration remains pending\./u);
    assert.match(content, /QA verifies both repositories\./u);
    await access(join(root, "workitems", "PROJ-123", "handoffs", "README.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem drift returns current evidence or a visible paused recovery state", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });

    const current = await runCli(
      ["workitem", "drift", "PROJ-123", "--fingerprint", fingerprint, "--json"],
      { cwd: root },
    );
    assert.equal(current.exitCode, 0);
    assert.deepEqual(JSON.parse(current.stdout), {
      key: "PROJ-123",
      state: "current",
      savedFingerprint: fingerprint,
      currentFingerprint: fingerprint,
    });

    const changed = await runCli(
      ["workitem", "drift", "PROJ-123", "--fingerprint", "sha256:changed"],
      { cwd: root },
    );
    assert.equal(changed.exitCode, 3);
    assert.match(changed.stdout, /paused/u);
    assert.match(changed.stdout, /recovery/u);
    assert.match(changed.stdout, /sha256:changed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status reports required artifacts and repository references only", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      key: "PROJ-123",
      jiraUrl,
      fingerprint,
      artifacts: [
        { path: "workitem.yaml", state: "present" },
        { path: "requirements.md", state: "present" },
        { path: "design.md", state: "present" },
        { path: "plan.md", state: "present" },
        { path: "tests.md", state: "present" },
        { path: "repositories.yaml", state: "present" },
        { path: "handoffs/README.md", state: "present" },
        { path: "decisions/README.md", state: "present" },
      ],
      repositories,
      handoffCount: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status rejects credential-bearing repository metadata instead of echoing it", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    await writeFile(
      join(root, "workitems", "PROJ-123", "workitem.yaml"),
      `schemaVersion: 1\nkey: PROJ-123\njira:\n  url: ${jiraUrl}\n  fingerprint: ${fingerprint}\nrepositories:\n  - name: frontend\n    path: projects/frontend\n    repository: ssh://token%3Asecret@example.test/team/frontend.git\n`,
      "utf8",
    );

    const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });
    assert.equal(result.exitCode, 2);
    assert.doesNotMatch(result.stdout, /token|secret/u);
    assert.doesNotMatch(result.stderr, /token|secret/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem CLI creates from configured projects and rejects malformed arguments", async () => {
  const root = await temporaryRoot();
  const config = configWithProjects(repositories);

  try {
    const create = await runCli(
      [
        "workitem",
        "create",
        "PROJ-123",
        "--jira-url",
        jiraUrl,
        "--fingerprint",
        fingerprint,
        "--project",
        "frontend",
        "--project",
        "backend",
        "--json",
      ],
      { cwd: root, dependencies: { workitemCommand: { loadConfig: async () => config } } },
    );
    assert.equal(create.exitCode, 0);
    assert.deepEqual(JSON.parse(create.stdout), {
      key: "PROJ-123",
      action: "created",
      repositories,
    });

    for (const argv of [
      ["workitem", "create", "PROJ-124", "--jira-url", jiraUrl, "--fingerprint", fingerprint],
      ["workitem", "create", "PROJ-124", "--jira-url"],
      ["workitem", "status", "PROJ-123", "--unknown", "--json"],
      ["workitem", "handoff", "PROJ-123", "--role", "writer", "--summary", "x", "--risk", "x", "--next", "x"],
    ]) {
      const result = await runCli(argv, {
        cwd: root,
        dependencies: { workitemCommand: { loadConfig: async () => config } },
      });
      assert.equal(result.exitCode, 2, argv.join(" "));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem creation rejects an escaping workitems symlink", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();

  try {
    await symlink(outside, join(root, "workitems"), "dir");
    await assert.rejects(
      () => createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories }),
      (error: unknown) =>
        error instanceof SaberError && error.exitCode === 2 && /symbolic link|escapes repository root/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
