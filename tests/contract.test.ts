import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("CLI exposes setup as the sole public command", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.stdout, "Usage: saber setup\n");

  for (const command of ["init", "validate", "doctor", "status", "external", "action", "materialize", "uninstall", "workitem", "knowledge"]) {
    const result = await runCli([command]);
    assert.equal(result.exitCode, 2, command);
    assert.match(result.stderr, /Unknown command/u);
  }
  const argumentsRejected = await runCli(["setup", "--tool", "codex"]);
  assert.equal(argumentsRejected.exitCode, 2);
  assert.match(argumentsRejected.stderr, /does not accept arguments/u);
});

test("Saber-owned Skill contracts preserve read-only knowledge and local-only promotion", async () => {
  const knowledge = await readFile(join(repositoryRoot, "skills", "team-knowledge", "SKILL.md"), "utf8");
  assert.match(knowledge, /at most one matching Requirement, one matching Architecture document and three matching Knowledge cards/u);
  assert.match(knowledge, /never run Git commands that change state/u);
  assert.match(knowledge, /Do not create an index, embeddings, a graph/u);

  const promote = await readFile(join(repositoryRoot, "skills", "promote", "SKILL.md"), "utf8");
  assert.match(promote, /local `main`/u);
  assert.match(promote, /clean worktree/u);
  assert.match(promote, /Never run `git fetch`, `git pull`, `git push`, `git merge`/u);
  assert.match(promote, /one local commit/u);
});
