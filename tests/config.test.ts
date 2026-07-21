import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SaberError } from "../src/lib/errors.js";
import { readTextWithinRoot, resolveWithinRoot } from "../src/lib/files.js";
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

test("resolveWithinRoot rejects paths escaping the repository root", () => {
  assert.equal(resolveWithinRoot("/workspace/saber", "mcp/capabilities.yaml"), "/workspace/saber/mcp/capabilities.yaml");

  assert.throws(
    () => resolveWithinRoot("/workspace/saber", "../outside.yaml"),
    (error: unknown) => error instanceof SaberError && /escapes repository root/.test(error.message),
  );
  assert.throws(
    () => resolveWithinRoot("/workspace/saber", "C:\\outside.yaml"),
    (error: unknown) => error instanceof SaberError && /escapes repository root/.test(error.message),
  );
});

test("readTextWithinRoot rejects a symlink whose real target escapes the repository root", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "saber-root-boundary-"));
  const repositoryRoot = join(temporaryDirectory, "repository");
  const externalFile = join(temporaryDirectory, "external.yaml");

  try {
    await mkdir(repositoryRoot);
    await writeFile(join(repositoryRoot, "inside.yaml"), "inside: true\n", "utf8");
    await writeFile(externalFile, "outside: true\n", "utf8");
    await symlink(externalFile, join(repositoryRoot, "escape.yaml"));

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
