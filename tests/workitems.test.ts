import assert from "node:assert/strict";
import {
  access,
  copyFile as nodeCopyFile,
  link as nodeLink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as nodeRename,
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
  advanceWorkitem,
  appendWorkitemHandoff,
  createWorkitem,
  getWorkitemStatus,
  pauseWorkitem,
  readWorkitemMetadata,
  resumeWorkitem,
  type WorkitemRepositoryReference,
} from "../src/lib/workitems.js";
import { SaberError } from "../src/lib/errors.js";
import type { RepositoryConfig } from "../src/lib/models.js";
import { transition } from "../src/lib/workflow-loop.js";

const sourceContent = "# 已确认的需求输入\n\n订单备注最多 200 个字符。\n";
const fingerprint = "sha256:711bcd69b829af473679233b188356782ceb4d9e425225846984f99bc548649e";
const source = {
  kind: "chat" as const,
  title: "订单备注长度需求",
  content: sourceContent,
  capturedAt: "2026-07-22T00:00:00.000Z",
  references: ["docs/order-note.md"],
};

function workitemInput(key = "PROJ-123") {
  return { key, source, repositories };
}

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
    await createWorkitem(root, workitemInput());

    const workitemRoot = join(root, "workitems", "PROJ-123");
    assert.deepEqual((await readdir(workitemRoot)).sort(), [
      "decisions",
      "design.md",
      "handoffs",
      "intake.md",
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

    const metadata = parse(await readFile(join(workitemRoot, "workitem.yaml"), "utf8")) as {
      schemaVersion: number;
      workflow: { state: string; role: string; iteration: number; history: unknown[]; updatedAt: string };
    };
    assert.equal(metadata.schemaVersion, 3);
    assert.deepEqual(
      { ...metadata.workflow, updatedAt: "<timestamp>" },
      {
        state: "ba-clarify",
        role: "ba",
        iteration: 0,
        pausedFrom: null,
        pauseReason: null,
        updatedAt: "<timestamp>",
        history: [],
      },
    );
    const repositoryEvidence = await readFile(join(workitemRoot, "repositories.yaml"), "utf8");
    assert.match(repositoryEvidence, /frontend/u);
    assert.match(repositoryEvidence, /backend/u);
    assert.equal(await readFile(join(workitemRoot, "intake.md"), "utf8"), sourceContent);
    assert.match(await readFile(join(workitemRoot, "requirements.md"), "utf8"), /BA 确认/u);
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
    const input = workitemInput();
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

test("workitem creation supports every canonical source kind and computes its snapshot fingerprint", async () => {
  for (const kind of ["chat", "jira", "document", "manual"] as const) {
    const root = await temporaryRoot();
    try {
      const metadata = await createWorkitem(root, {
        key: `SOURCE-${kind === "chat" ? 1 : kind === "jira" ? 2 : kind === "document" ? 3 : 4}`,
        source: { ...source, kind, ...(kind === "jira" ? { origin: "https://jira.example.test/browse/SOURCE-2" } : {}) },
        repositories,
      });
      assert.equal(metadata.source.kind, kind);
      assert.equal(metadata.source.fingerprint, fingerprint);
      assert.equal(
        await readFile(join(root, "workitems", metadata.key, "intake.md"), "utf8"),
        sourceContent,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("workitem CLI generates the next daily SABER key and never accepts inline source text", async () => {
  const root = await temporaryRoot();
  const config = configWithProjects(repositories);
  try {
    await mkdir(join(root, "workitems", "SABER-20260722-002"), { recursive: true });
    await writeFile(join(root, "draft.md"), sourceContent, "utf8");
    const created = await runCli(
      [
        "workitem", "create",
        "--source-type", "chat",
        "--source-title", "订单备注",
        "--source-file", "draft.md",
        "--project", "frontend",
        "--json",
      ],
      {
        cwd: root,
        dependencies: {
          workitemCommand: {
            loadConfig: async () => config,
            now: () => new Date("2026-07-22T12:00:00.000Z"),
          },
        },
      },
    );
    assert.equal(created.exitCode, 0, created.stdout);
    assert.equal((JSON.parse(created.stdout) as { key: string }).key, "SABER-20260722-003");

    const inline = await runCli(
      ["workitem", "create", "--source-type", "chat", "--source-title", "x", "--source-text", "secret", "--project", "frontend"],
      { cwd: root, dependencies: { workitemCommand: { loadConfig: async () => config } } },
    );
    assert.equal(inline.exitCode, 2);
    assert.doesNotMatch(inline.stderr, /secret/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem handoff appends a timestamped role record rather than chat history", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, workitemInput());
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
    await createWorkitem(root, workitemInput());

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
    await createWorkitem(root, workitemInput());
    const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });

    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    const workflow = report.workflow as Record<string, unknown>;
    assert.deepEqual({ ...report, workflow: undefined, suggestion: undefined }, {
      key: "PROJ-123",
      source: {
        kind: "chat",
        title: source.title,
        snapshot: "intake.md",
        fingerprint,
        capturedAt: source.capturedAt,
        references: source.references,
      },
      fingerprint,
      artifacts: [
        { path: "workitem.yaml", state: "present" },
        { path: "intake.md", state: "present" },
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
      workflow: undefined,
      suggestion: undefined,
    });
    assert.deepEqual({ ...workflow, updatedAt: "<timestamp>" }, {
      state: "ba-clarify",
      role: "ba",
      iteration: 0,
      pausedFrom: null,
      pauseReason: null,
      updatedAt: "<timestamp>",
      history: [],
    });
    assert.equal(report.suggestion, "saber next PROJ-123 --result ready --fingerprint <current-fingerprint>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem status matches current repository evidence by stable name after reordering", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, workitemInput());
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
    await createWorkitem(root, workitemInput());
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
    await createWorkitem(root, workitemInput());
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
    await createWorkitem(root, workitemInput());
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
    await createWorkitem(root, workitemInput());
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

test("workitem CLI creates a source snapshot and normalizes capturedAt", async () => {
  const root = await temporaryRoot();
  const config = configWithProjects(repositories);

  try {
    await writeFile(join(root, "draft.md"), sourceContent, "utf8");
    const result = await runCli(
      [
        "workitem",
        "create",
        "PROJ-124",
        "--source-type",
        "jira",
        "--source-title",
        "订单备注",
        "--source-file",
        "draft.md",
        "--source-origin",
        "https://jira.example.test/browse/PROJ-124",
        "--captured-at",
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
    assert.equal((JSON.parse(status.stdout) as { source: { capturedAt: string } }).source.capturedAt, "2026-07-22T00:30:45.000Z");
    assert.equal(text.exitCode, 0);
    assert.match(text.stdout, /Captured at: 2026-07-22T00:30:45\.000Z/u);
    const metadata = parse(await readFile(join(root, "workitems", "PROJ-124", "workitem.yaml"), "utf8")) as {
      source: { capturedAt: string; kind: string };
    };
    assert.deepEqual(metadata.source, {
      kind: "jira",
      title: "订单备注",
      origin: "https://jira.example.test/browse/PROJ-124",
      snapshot: "intake.md",
      fingerprint,
      capturedAt: "2026-07-22T00:30:45.000Z",
      references: [],
    });

    const invalid = await runCli(
      [
        "workitem",
        "create",
        "PROJ-125",
        "--source-type", "chat",
        "--source-title", "错误日期",
        "--source-file", "draft.md",
        "--captured-at",
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

test("workitem status rejects the retired Jira schema", async () => {
  const root = await temporaryRoot();

  try {
    await createWorkitem(root, workitemInput());
    await writeFile(
      join(root, "workitems", "PROJ-123", "workitem.yaml"),
      `schemaVersion: 2\nkey: PROJ-123\njira:\n  url: https://jira.example.test/browse/PROJ-123\n  fingerprint: ${fingerprint}\nrepositories: []\nworkflow: {}\n`,
      "utf8",
    );

    const result = await runCli(["workitem", "status", "PROJ-123", "--json"], { cwd: root });
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /invalid metadata/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem CLI creates from configured projects and rejects malformed arguments", async () => {
  const root = await temporaryRoot();
  const config = configWithProjects(repositories);

  try {
    await writeFile(join(root, "draft.md"), sourceContent, "utf8");
    const create = await runCli(
      [
        "workitem",
        "create",
        "PROJ-123",
        "--source-type", "chat",
        "--source-title", "订单备注",
        "--source-file", "draft.md",
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
      ["workitem", "create", "PROJ-124", "--source-text", "secret", "--project", "frontend"],
      ["workitem", "create", "PROJ-124", "--source-file"],
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
    await createWorkitem(root, workitemInput());
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

    const withoutFingerprint = await runCli(
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
    assert.equal(withoutFingerprint.exitCode, 0);
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
      () => createWorkitem(root, workitemInput()),
      (error: unknown) =>
        error instanceof SaberError && error.exitCode === 2 && /symbolic link|escapes repository root/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

const transitionText = {
  summary: "Stage evidence is ready.",
  risk: "No unresolved blocker.",
  next: "The next role reviews the evidence.",
};

async function advance(
  root: string,
  result: string,
  minute: number,
  includeFingerprint = false,
): Promise<void> {
  await advanceWorkitem(root, {
    key: "PROJ-123",
    result,
    ...transitionText,
    ...(includeFingerprint ? { fingerprint } : {}),
    now: new Date(`2026-07-22T10:${String(minute).padStart(2, "0")}:00.000Z`),
  });
}

test("workflow transition table rejects every unsupported role result", () => {
  assert.equal(transition("ba-clarify", "ready"), "dev-build");
  assert.equal(transition("qa-verify", "fail"), "dev-fix");
  assert.equal(transition("ba-accept", "accept"), "done");
  assert.throws(
    () => transition("ba-clarify", "pass"),
    (error: unknown) => error instanceof SaberError && error.exitCode === 2,
  );
  assert.throws(
    () => transition("done", "ready"),
    (error: unknown) => error instanceof SaberError && error.exitCode === 2,
  );
});

test("workitem loop completes the direct BA Dev QA BA path", async () => {
  const root = await temporaryRoot();
  try {
    await createWorkitem(root, workitemInput());
    await advance(root, "ready", 1, true);
    await advance(root, "ready", 2);
    await advance(root, "pass", 3);
    await advance(root, "accept", 4, true);

    const status = await getWorkitemStatus(root, "PROJ-123");
    assert.equal(status.workflow.state, "done");
    assert.equal(status.workflow.role, null);
    assert.equal(status.workflow.iteration, 0);
    assert.equal(status.workflow.history.length, 4);
    assert.equal(status.handoffCount, 4);
    assert.equal(status.suggestion, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem loop returns QA failures and BA rejections through Dev fix", async () => {
  const root = await temporaryRoot();
  try {
    await createWorkitem(root, workitemInput());
    await advance(root, "ready", 1, true);
    await advance(root, "ready", 2);
    await advance(root, "fail", 3);
    await advance(root, "ready", 4);
    await advance(root, "pass", 5);
    await advance(root, "reject", 6);
    await advance(root, "ready", 7);
    await advance(root, "pass", 8);
    await advance(root, "accept", 9, true);

    const metadata = await readWorkitemMetadata(root, "PROJ-123");
    assert.equal(metadata.workflow.state, "done");
    assert.equal(metadata.workflow.iteration, 2);
    assert.deepEqual(
      metadata.workflow.history.map(({ from, to, result }) => ({ from, to, result })),
      [
        { from: "ba-clarify", to: "dev-build", result: "ready" },
        { from: "dev-build", to: "qa-verify", result: "ready" },
        { from: "qa-verify", to: "dev-fix", result: "fail" },
        { from: "dev-fix", to: "qa-verify", result: "ready" },
        { from: "qa-verify", to: "ba-accept", result: "pass" },
        { from: "ba-accept", to: "dev-fix", result: "reject" },
        { from: "dev-fix", to: "qa-verify", result: "ready" },
        { from: "qa-verify", to: "ba-accept", result: "pass" },
        { from: "ba-accept", to: "done", result: "accept" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workitem loop pauses, detects drift, and resumes its owning role", async () => {
  const root = await temporaryRoot();
  try {
    await createWorkitem(root, workitemInput());
    const paused = await pauseWorkitem(root, {
      key: "PROJ-123",
      reason: "Waiting for a business decision.",
      now: new Date("2026-07-22T10:01:00.000Z"),
    });
    assert.equal(paused.to, "paused");
    await assert.rejects(
      () => resumeWorkitem(root, { key: "PROJ-123", fingerprint: "sha256:changed" }),
      (error: unknown) => error instanceof SaberError && error.exitCode === 3,
    );
    const stillPaused = await readWorkitemMetadata(root, "PROJ-123");
    assert.equal(stillPaused.workflow.state, "paused");

    await resumeWorkitem(root, {
      key: "PROJ-123",
      fingerprint,
      now: new Date("2026-07-22T10:02:00.000Z"),
    });
    const resumed = await readWorkitemMetadata(root, "PROJ-123");
    assert.equal(resumed.workflow.state, "ba-clarify");
    assert.equal(resumed.workflow.role, "ba");
    assert.equal(resumed.workflow.pauseReason, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retired workitem schemas are rejected without an upgrade path", async () => {
  const root = await temporaryRoot();
  try {
    await createWorkitem(root, workitemInput());
    const metadataPath = join(root, "workitems", "PROJ-123", "workitem.yaml");
    const metadata = parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.schemaVersion = 2;
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

    await assert.rejects(
      () => readWorkitemMetadata(root, "PROJ-123"),
      (error: unknown) => error instanceof SaberError && /invalid metadata/u.test(error.message),
    );
    assert.equal((parse(await readFile(metadataPath, "utf8")) as { schemaVersion: number }).schemaVersion, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow gates leave metadata and handoffs unchanged when evidence is missing", async () => {
  const root = await temporaryRoot();
  try {
    await createWorkitem(root, workitemInput());
    await advance(root, "ready", 1, true);
    await unlink(join(root, "workitems", "PROJ-123", "design.md"));
    const metadataPath = join(root, "workitems", "PROJ-123", "workitem.yaml");
    const handoffsPath = join(root, "workitems", "PROJ-123", "handoffs");
    const beforeMetadata = await readFile(metadataPath, "utf8");
    const beforeHandoffs = await readdir(handoffsPath);

    await assert.rejects(
      () => advance(root, "ready", 2),
      (error: unknown) =>
        error instanceof SaberError && error.exitCode === 3 && /design\.md/u.test(error.message),
    );
    assert.equal(await readFile(metadataPath, "utf8"), beforeMetadata);
    assert.deepEqual(await readdir(handoffsPath), beforeHandoffs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BA gates require a current source fingerprint before starting or accepting", async () => {
  const root = await temporaryRoot();
  try {
    await createWorkitem(root, workitemInput());
    const metadataPath = join(root, "workitems", "PROJ-123", "workitem.yaml");
    const handoffsPath = join(root, "workitems", "PROJ-123", "handoffs");
    const initialMetadata = await readFile(metadataPath, "utf8");

    await assert.rejects(
      () => advanceWorkitem(root, { key: "PROJ-123", result: "ready", ...transitionText }),
      (error: unknown) =>
        error instanceof SaberError && error.exitCode === 3 && /fingerprint is required/u.test(error.message),
    );
    assert.equal(await readFile(metadataPath, "utf8"), initialMetadata);
    assert.equal((await readdir(handoffsPath)).length, 1);

    await advance(root, "ready", 1, true);
    await advance(root, "ready", 2);
    await advance(root, "pass", 3);
    const beforeAccept = await readFile(metadataPath, "utf8");
    const beforeHandoffs = await readdir(handoffsPath);
    await assert.rejects(
      () => advanceWorkitem(root, { key: "PROJ-123", result: "accept", ...transitionText }),
      (error: unknown) =>
        error instanceof SaberError && error.exitCode === 3 && /fingerprint is required/u.test(error.message),
    );
    assert.equal(await readFile(metadataPath, "utf8"), beforeAccept);
    assert.deepEqual(await readdir(handoffsPath), beforeHandoffs);
    assert.equal((await readWorkitemMetadata(root, "PROJ-123")).workflow.state, "ba-accept");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow persistence rolls back metadata and handoff publication failures", async () => {
  for (const failure of ["metadata", "handoff"] as const) {
    const root = await temporaryRoot();
    try {
      await createWorkitem(root, workitemInput());
      const metadataPath = join(root, "workitems", "PROJ-123", "workitem.yaml");
      const handoffsPath = join(root, "workitems", "PROJ-123", "handoffs");
      const beforeMetadata = await readFile(metadataPath, "utf8");
      const beforeHandoffs = await readdir(handoffsPath);

      await assert.rejects(
        () => advanceWorkitem(
          root,
          {
            key: "PROJ-123",
            result: "ready",
            fingerprint,
            ...transitionText,
            now: new Date("2026-07-22T10:01:00.000Z"),
          },
          failure === "metadata"
            ? {
                rename: async (source, destination) => {
                  if (source.endsWith("/next-workitem.yaml")) throw new Error("injected metadata failure");
                  await nodeRename(source, destination);
                },
              }
            : {
                link: async (source, destination) => {
                  if (source.endsWith("/next-handoff.md")) throw new Error("injected handoff failure");
                  await nodeLink(source, destination);
                },
              },
        ),
        (error: unknown) => error instanceof SaberError && error.exitCode === 1,
      );

      assert.equal(await readFile(metadataPath, "utf8"), beforeMetadata, `${failure} changed metadata`);
      assert.deepEqual(await readdir(handoffsPath), beforeHandoffs, `${failure} published a handoff`);
      await assert.rejects(
        access(join(root, "workitems", "PROJ-123", ".workflow-transaction")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("an orphaned workflow transaction rolls back before the next read", async () => {
  const root = await temporaryRoot();
  try {
    await createWorkitem(root, workitemInput());
    const workitemRoot = join(root, "workitems", "PROJ-123");
    const metadataPath = join(workitemRoot, "workitem.yaml");
    const transactionRoot = join(workitemRoot, ".workflow-transaction");
    const handoffPath = "handoffs/2026-07-22T10-01-00.000Z-ba.md";
    const original = await readFile(metadataPath, "utf8");

    await mkdir(transactionRoot);
    await writeFile(
      join(transactionRoot, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        key: "PROJ-123",
        ownerPid: 2_147_483_647,
        phase: "metadata-promoted",
        handoffPath,
      })}\n`,
      "utf8",
    );
    await writeFile(join(transactionRoot, "previous-workitem.yaml"), original, "utf8");
    await writeFile(metadataPath, "invalid promoted metadata\n", "utf8");
    const stagedHandoff = join(transactionRoot, "next-handoff.md");
    await writeFile(stagedHandoff, "partial handoff\n", "utf8");
    await nodeLink(stagedHandoff, join(workitemRoot, handoffPath));

    const recovered = await readWorkitemMetadata(root, "PROJ-123");
    assert.equal(recovered.workflow.state, "ba-clarify");
    assert.equal(await readFile(metadataPath, "utf8"), original);
    await assert.rejects(access(transactionRoot), { code: "ENOENT" });
    await assert.rejects(access(join(workitemRoot, handoffPath)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
