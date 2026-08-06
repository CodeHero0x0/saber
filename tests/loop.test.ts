import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stateScript = join(repositoryRoot, "skills", "loop", "scripts", "loop-state.mjs");
const hookScript = join(repositoryRoot, "skills", "loop", "scripts", "loop-hook.mjs");

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

async function state(cwd: string, ...args: string[]): Promise<Record<string, any>> {
  const result = await exec(process.execPath, [stateScript, ...args], { cwd });
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function hook(cwd: string, input: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [hookScript], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code !== 0) return rejectPromise(new Error(stderr || `hook exited ${code}`));
      resolvePromise(stdout.trim() ? JSON.parse(stdout) as Record<string, any> : undefined);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function fixture(): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "saber-loop-"));
  const project = join(root, "projects", "backend");
  await mkdir(join(root, "requirements", "stories"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(root, "saber.yaml"), [
    "schemaVersion: 2",
    "projects: []",
    "skills:",
    "  sources: []",
    "loop:",
    "  evidenceBranch: origin/main",
    "  maxIterations: 8",
    "  maxNoProgressIterations: 3",
    "  maxMinutes: 60",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, ".gitignore"), "/projects/\n/.saber/\n", "utf8");
  await writeFile(join(root, "requirements", "stories", "STORY-123.md"), "---\nid: STORY-123\n---\n# Refunds\n", "utf8");
  await git(root, ["init", "--initial-branch", "main"]);
  await git(root, ["config", "user.name", "Zhang San"]);
  await git(root, ["config", "user.email", "zhangsan@example.test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "add story"]);
  const remote = join(root, ".saber-test-remote.git");
  await git(root, ["init", "--bare", remote]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);

  await git(project, ["init", "--initial-branch", "main"]);
  await git(project, ["config", "user.name", "Zhang San"]);
  await git(project, ["config", "user.email", "zhangsan@example.test"]);
  await writeFile(join(project, "app.txt"), "initial\n", "utf8");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "initial"]);
  return { root, project };
}

test("loop freezes pushed evidence and advances only the pending checkpoint with exact confirmation", async () => {
  const { root, project } = await fixture();
  try {
    const started = await state(project, "start", "STORY-123");
    assert.equal(started.requirementId, "STORY-123");
    assert.equal(started.member, "zhangsan");
    assert.equal(started.phase, "grilling");
    assert.match(started.evidence.commit, /^[0-9a-f]{40}$/u);
    assert.match(started.evidence.digest, /^sha256:/u);
    assert.match(await readFile(join(root, "specs", "STORY-123", "zhangsan", "DECISIONS.md"), "utf8"), /STORY-123/iu);

    await state(project, "checkpoint", "grill");
    const waiting = await hook(project, { cwd: project, hook_event_name: "Stop", stop_hook_active: false });
    assert.equal(waiting?.continue, false);
    assert.match(String(waiting?.stopReason), /grill approval/u);

    const ignored = await hook(project, { cwd: project, hook_event_name: "UserPromptSubmit", prompt: "好的" });
    assert.equal(ignored, undefined);
    assert.equal((await state(project, "status")).status, "awaiting-human");

    const punctuated = await hook(project, { cwd: project, hook_event_name: "UserPromptSubmit", prompt: "确认。" });
    assert.equal(punctuated, undefined);
    assert.equal((await state(project, "status")).status, "awaiting-human");

    const approved = await hook(project, { cwd: project, hook_event_name: "UserPromptSubmit", prompt: "确认" });
    assert.match(JSON.stringify(approved), /specifying/u);
    const current = await state(project, "status");
    assert.equal(current.approvals.grill, true);
    assert.equal(current.phase, "specifying");
    const earlyWrite = await hook(project, {
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: app.txt" },
    });
    assert.equal(earlyWrite?.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loop hooks block evidence writes and reject stale verification at completion", async () => {
  const { root, project } = await fixture();
  try {
    await state(project, "start", "STORY-123");
    const artifactRoot = join(root, "specs", "STORY-123", "zhangsan");
    await writeFile(join(artifactRoot, "SPEC.md"), "# Spec\n", "utf8");
    await writeFile(join(artifactRoot, "TICKETS.md"), "# Tickets\n", "utf8");
    await state(project, "ticket-add", "01-refund");
    await state(project, "ticket-add", "02-idempotency", "01-refund");
    for (const checkpoint of ["grill", "spec", "tickets"]) {
      await state(project, "checkpoint", checkpoint);
      await hook(project, { cwd: project, hook_event_name: "UserPromptSubmit", prompt: "确认" });
    }
    await assert.rejects(() => exec(process.execPath, [stateScript, "ticket", "02-idempotency", "running"], { cwd: project }), /blocked by 01-refund/u);
    await state(project, "ticket", "01-refund", "complete");
    await state(project, "ticket", "02-idempotency", "complete");
    await state(project, "verify-command", "node --test");
    await state(project, "review", "ponytail", "pass");
    await state(project, "review", "code", "pass");
    await writeFile(join(artifactRoot, "RESULT.md"), "# Result\n", "utf8");

    const denied = await hook(project, {
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: ../../requirements/stories/STORY-123.md" },
    });
    assert.equal(denied?.hookSpecificOutput?.permissionDecision, "deny");

    await hook(project, {
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "node --test" },
      tool_response: { exit_code: 0, output: "pass" },
    });
    await writeFile(join(project, "app.txt"), "changed after verification\n", "utf8");
    await assert.rejects(() => exec(process.execPath, [stateScript, "complete"], { cwd: project }), /verification is stale/u);

    await hook(project, {
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "node --test" },
      tool_response: { exit_code: 0, output: "pass" },
    });
    const completed = await state(project, "complete");
    assert.equal(completed.status, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tickets approval fails if business code changed during discovery or specification", async () => {
  const { root, project } = await fixture();
  try {
    await state(project, "start", "STORY-123");
    const artifactRoot = join(root, "specs", "STORY-123", "zhangsan");
    await writeFile(join(artifactRoot, "SPEC.md"), "# Spec\n", "utf8");
    await writeFile(join(artifactRoot, "TICKETS.md"), "# Tickets\n", "utf8");
    await state(project, "ticket-add", "01-refund");
    for (const checkpoint of ["grill", "spec"]) {
      await state(project, "checkpoint", checkpoint);
      await hook(project, { cwd: project, hook_event_name: "UserPromptSubmit", prompt: "确认" });
    }
    await writeFile(join(project, "app.txt"), "changed too early\n", "utf8");
    await state(project, "checkpoint", "tickets");
    await assert.rejects(
      () => hook(project, { cwd: project, hook_event_name: "UserPromptSubmit", prompt: "确认" }),
      /business workspace changed before tickets approval/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
