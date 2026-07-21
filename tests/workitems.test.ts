import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
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

const initialRepositoryEvidence = repositories.map((repository) => ({
  ...repository,
  branch: null,
  commit: null,
  mergeRequest: null,
  ci: "not-recorded",
}));

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
      updatedAt: null,
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
      repositories: initialRepositoryEvidence,
      handoffCount: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status matches current repository evidence by stable name after reordering", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    await writeFile(
      join(root, "workitems", "PROJ-123", "repositories.yaml"),
      `schemaVersion: 1\nrepositories:\n  - name: backend\n    path: projects/backend\n    repository: https://git.example.test/team/backend.git\n    branch: main\n    commit: b1c2d3e4\n    mergeRequest: "!77"\n    ci: running\n  - name: frontend\n    path: projects/frontend\n    repository: https://git.example.test/team/frontend.git\n    branch: codex/PROJ-123-api\n    commit: a1b2c3d4\n    mergeRequest: "!42"\n    ci: passed\n`,
      "utf8",
    );

    const json = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });
    const text = await runCli(["workitem", "status", "PROJ-123"], { cwd: root });

    assert.equal(json.exitCode, 0);
    assert.deepEqual((JSON.parse(json.stdout) as { repositories: unknown }).repositories, [
      {
        ...repositories[0],
        branch: "codex/PROJ-123-api",
        commit: "a1b2c3d4",
        mergeRequest: "!42",
        ci: "passed",
      },
      {
        ...repositories[1],
        branch: "main",
        commit: "b1c2d3e4",
        mergeRequest: "!77",
        ci: "running",
      },
    ]);
    assert.equal(text.exitCode, 0);
    assert.match(text.stdout, /branch: codex\/PROJ-123-api/u);
    assert.match(text.stdout, /commit: a1b2c3d4/u);
    assert.match(text.stdout, /merge request: !42/u);
    assert.match(text.stdout, /CI: passed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status reports a missing repository evidence file without failing", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    await unlink(join(root, "workitems", "PROJ-123", "repositories.yaml"));

    const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });

    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout) as {
      artifacts: Array<{ path: string; state: string }>;
      repositories: unknown;
    };
    assert.deepEqual(
      report.artifacts.find((artifact) => artifact.path === "repositories.yaml"),
      { path: "repositories.yaml", state: "missing" },
    );
    assert.deepEqual(report.repositories, repositories.map((repository) => ({
      ...repository,
      branch: null,
      commit: null,
      mergeRequest: null,
      ci: null,
    })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status reports duplicate, unknown, and missing repository targets as invalid", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    const evidencePath = join(root, "workitems", "PROJ-123", "repositories.yaml");
    const invalidEvidence = [
      {
        content: `schemaVersion: 1\nrepositories:\n  - name: frontend\n    path: projects/frontend\n    repository: https://git.example.test/team/frontend.git\n    branch: main\n    commit: null\n    mergeRequest: null\n    ci: pending\n  - name: frontend\n    path: projects/frontend\n    repository: https://git.example.test/team/frontend.git\n    branch: main\n    commit: null\n    mergeRequest: null\n    ci: pending\n`,
        detail: "duplicate repository target",
      },
      {
        content: `schemaVersion: 1\nrepositories:\n  - name: frontend\n    path: projects/frontend\n    repository: https://git.example.test/team/frontend.git\n    branch: main\n    commit: null\n    mergeRequest: null\n    ci: pending\n  - name: unknown\n    path: projects/unknown\n    repository: https://git.example.test/team/unknown.git\n    branch: main\n    commit: null\n    mergeRequest: null\n    ci: pending\n`,
        detail: "unknown repository target",
      },
      {
        content: `schemaVersion: 1\nrepositories:\n  - name: frontend\n    path: projects/frontend\n    repository: https://git.example.test/team/frontend.git\n    branch: main\n    commit: null\n    mergeRequest: null\n    ci: pending\n`,
        detail: "missing repository target",
      },
    ];

    for (const { content, detail } of invalidEvidence) {
      await writeFile(evidencePath, content, "utf8");
      const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });
      assert.equal(result.exitCode, 0);
      const report = JSON.parse(result.stdout) as {
        artifacts: Array<{ path: string; state: string }>;
        repositories: unknown;
      };
      assert.deepEqual(
        report.artifacts.find((artifact) => artifact.path === "repositories.yaml"),
        { path: "repositories.yaml", state: "invalid", detail },
      );
      assert.deepEqual(report.repositories, repositories.map((repository) => ({
        ...repository,
        branch: null,
        commit: null,
        mergeRequest: null,
        ci: null,
      })));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status rejects malformed repository evidence without echoing a sensitive URL", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    await writeFile(
      join(root, "workitems", "PROJ-123", "repositories.yaml"),
      `schemaVersion: 1\nrepositories:\n  - name: frontend\n    path: projects/frontend\n    repository: ssh://token%3Asecret@example.test/team/frontend.git\n    branch: main\n    commit: a1b2c3d4\n    mergeRequest: "!42"\n    ci: passed\n`,
      "utf8",
    );

    const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /invalid repository evidence/u);
    assert.doesNotMatch(result.stdout, /token|secret/u);
    assert.doesNotMatch(result.stderr, /token|secret/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status fails closed for an unsafe repository evidence path", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    await writeFile(
      join(root, "workitems", "PROJ-123", "repositories.yaml"),
      `schemaVersion: 1\nrepositories:\n  - name: frontend\n    path: ../../outside\n    repository: https://git.example.test/team/frontend.git\n    branch: main\n    commit: a1b2c3d4\n    mergeRequest: "!42"\n    ci: passed\n`,
      "utf8",
    );

    const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /invalid repository evidence/u);
    assert.doesNotMatch(result.stdout, /outside/u);
    assert.doesNotMatch(result.stderr, /outside/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem create persists an explicitly supplied Jira updatedAt and leaves absent input unknown", async () => {
  const root = await temporaryRoot();
  const config = configWithProjects(repositories);

  try {
    const result = await runCli(
      [
        "workitem",
        "create",
        "PROJ-124",
        "--jira-url",
        "https://jira.example.test/browse/PROJ-124",
        "--fingerprint",
        fingerprint,
        "--updated-at",
        "2026-07-22T08:30:45+08:00",
        "--project",
        "frontend",
      ],
      { cwd: root, dependencies: { workitemCommand: { loadConfig: async () => config } } },
    );
    assert.equal(result.exitCode, 0);

    const status = await runCli(["workitem", "status", "PROJ-124", "--json"], { cwd: root });
    const text = await runCli(["workitem", "status", "PROJ-124"], { cwd: root });
    assert.equal(status.exitCode, 0);
    assert.equal(
      (JSON.parse(status.stdout) as { updatedAt: string | null }).updatedAt,
      "2026-07-22T00:30:45.000Z",
    );
    assert.equal(text.exitCode, 0);
    assert.match(text.stdout, /Jira updated at: 2026-07-22T00:30:45\.000Z/u);
    const metadata = parse(await readFile(join(root, "workitems", "PROJ-124", "workitem.yaml"), "utf8")) as {
      jira: { updatedAt?: string };
    };
    assert.equal(metadata.jira.updatedAt, "2026-07-22T00:30:45.000Z");

    const invalid = await runCli(
      [
        "workitem",
        "create",
        "PROJ-125",
        "--jira-url",
        "https://jira.example.test/browse/PROJ-125",
        "--fingerprint",
        fingerprint,
        "--updated-at",
        "2026-02-30T00:00:00Z",
        "--project",
        "frontend",
      ],
      { cwd: root, dependencies: { workitemCommand: { loadConfig: async () => config } } },
    );
    assert.equal(invalid.exitCode, 2);
    await assert.rejects(access(join(root, "workitems", "PROJ-125")));
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

test("workitem handoff with a supplied changed fingerprint pauses without writing a handoff", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, { key: "PROJ-123", jiraUrl, fingerprint, repositories });
    const handoffsPath = join(root, "workitems", "PROJ-123", "handoffs");
    const before = await readdir(handoffsPath);

    const paused = await runCli(
      [
        "workitem",
        "handoff",
        "PROJ-123",
        "--role",
        "dev",
        "--summary",
        "Implemented the API contract.",
        "--risk",
        "No additional risk.",
        "--next",
        "QA validates the change.",
        "--fingerprint",
        "sha256:changed",
        "--json",
      ],
      { cwd: root },
    );
    assert.equal(paused.exitCode, 3);
    assert.deepEqual(JSON.parse(paused.stdout), {
      key: "PROJ-123",
      state: "paused",
      savedFingerprint: fingerprint,
      currentFingerprint: "sha256:changed",
    });
    assert.deepEqual(await readdir(handoffsPath), before);

    const compatible = await runCli(
      [
        "workitem",
        "handoff",
        "PROJ-123",
        "--role",
        "dev",
        "--summary",
        "Implemented the API contract.",
        "--risk",
        "No additional risk.",
        "--next",
        "QA validates the change.",
      ],
      { cwd: root, dependencies: { workitemCommand: { now: () => new Date("2026-07-22T09:00:00.000Z") } } },
    );
    assert.equal(compatible.exitCode, 0);
    assert.deepEqual((await readdir(handoffsPath)).sort(), [
      "2026-07-22T09-00-00.000Z-dev.md",
      "README.md",
    ]);
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
