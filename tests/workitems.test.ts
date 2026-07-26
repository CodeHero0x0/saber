import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkitem, getWorkitemStatus } from "../src/lib/workitems.js";

async function fixture() {
  return mkdtemp(join(tmpdir(), "saber-workitems-"));
}

test("a supplied Jira key creates one validated Markdown workitem", async () => {
  const root = await fixture();
  try {
    const workitem = await createWorkitem(root, {
      key: "PROJ-123",
      source: { kind: "jira", title: "改善路由", content: "Jira 输入。", references: ["PROJ-123"] },
    });
    assert.equal(workitem.path, "workitems/PROJ-123.md");
    assert.match(await readFile(join(root, workitem.path), "utf8"), /^---\nschemaVersion: 1/mu);
    await assert.rejects(() => lstat(join(root, "workitems/PROJ-123")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a descriptive title allocates a readable filename and avoids collisions", async () => {
  const root = await fixture();
  try {
    const source = { kind: "chat" as const, title: "自然语言路由", content: "输入。" };
    assert.equal((await createWorkitem(root, { source })).key, "自然语言路由");
    assert.equal((await createWorkitem(root, { source })).key, "自然语言路由-2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("status reports schema errors without suggesting a workflow transition", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "workitems"), { recursive: true });
    await writeFile(join(root, "workitems/PROJ-123.md"), [
      "---",
      "schemaVersion: 1",
      "id: PROJ-123",
      "title: 标题",
      "source:",
      "  kind: manual",
      "  capturedAt: 2026-07-26T00:00:00.000Z",
      "stage: dev",
      "---",
      "# 输入",
      "",
    ].join("\n"), "utf8");
    const report = await getWorkitemStatus(root, "PROJ-123");
    assert.equal(report.state, "invalid");
    assert.match(report.errors.join("\n"), /stage/u);
    assert.equal("suggestion" in report, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
