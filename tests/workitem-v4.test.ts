import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

import {
  advanceWorkitem,
  createWorkitem,
  getWorkitemStatus,
  pauseWorkitem,
  readWorkitemMetadata,
  resumeWorkitem,
} from "../src/lib/workitems.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "saber-workitem-v4-"));
  const metadata = await createWorkitem(root, {
    key: "PROJ-123",
    source: { kind: "chat", title: "Unified workflow", content: "Confirmed requirement.\n" },
    repositories: [{ name: "app", path: "projects/app" }],
    now: new Date("2026-07-23T00:00:00.000Z"),
  });
  return { root, metadata };
}

test("schema v4 creates exactly the seven-file evidence pack", async () => {
  const { root, metadata } = await fixture();
  try {
    assert.equal(metadata.schemaVersion, 4);
    assert.deepEqual((await readdir(join(root, "workitems/PROJ-123"))).sort(), [
      "design.md", "intake.md", "plan.md", "repositories.yaml",
      "requirements.md", "tests.md", "workitem.yaml",
    ]);
    const status = await getWorkitemStatus(root, "PROJ-123");
    assert.equal(status.artifacts.length, 7);
    assert.match(status.suggestion!, /^saber workitem advance/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow completes, persists summary risk next, and supports pause/resume", async () => {
  const { root, metadata } = await fixture();
  const step = (result: "ready" | "pass" | "accept", index: number, fingerprint?: string) =>
    advanceWorkitem(root, {
      key: metadata.key,
      result,
      summary: `summary-${index}`,
      risk: `risk-${index}`,
      next: `next-${index}`,
      fingerprint,
      now: new Date(`2026-07-23T0${index}:00:00.000Z`),
    });
  try {
    await step("ready", 1, metadata.source.fingerprint);
    await pauseWorkitem(root, { key: metadata.key, reason: "waiting for a decision" });
    assert.match((await getWorkitemStatus(root, metadata.key)).suggestion!, /^saber workitem resume/u);
    await resumeWorkitem(root, { key: metadata.key, fingerprint: metadata.source.fingerprint });
    await step("ready", 2);
    await step("pass", 3);
    await step("accept", 4, metadata.source.fingerprint);

    const current = await readWorkitemMetadata(root, metadata.key);
    assert.equal(current.workflow.state, "done");
    assert.equal(current.workflow.history.length, 6);
    assert.deepEqual(
      current.workflow.history.filter(({ result }) => result !== "paused" && result !== "resume")
        .map(({ summary, risk, next }) => ({ summary, risk, next })),
      [1, 2, 3, 4].map((index) => ({ summary: `summary-${index}`, risk: `risk-${index}`, next: `next-${index}` })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v3 metadata is rejected without migration", async () => {
  const { root } = await fixture();
  try {
    const path = join(root, "workitems/PROJ-123/workitem.yaml");
    const value = parse(await readFile(path, "utf8")) as Record<string, unknown>;
    value.schemaVersion = 3;
    await writeFile(path, stringify(value), "utf8");
    await assert.rejects(() => readWorkitemMetadata(root, "PROJ-123"), /invalid metadata/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow persistence rolls back when metadata promotion fails", async () => {
  const { root, metadata } = await fixture();
  try {
    await assert.rejects(
      () => advanceWorkitem(root, {
        key: metadata.key,
        result: "ready",
        summary: "ready",
        risk: "none",
        next: "build",
        fingerprint: metadata.source.fingerprint,
      }, {
        rename: async (source, destination) => {
          if (source.endsWith("next-workitem.yaml")) throw new Error("injected promotion failure");
          await rename(source, destination);
        },
      }),
      /could not update workflow/u,
    );
    const current = await readWorkitemMetadata(root, metadata.key);
    assert.equal(current.workflow.state, "ba-clarify");
    await assert.rejects(() => readFile(join(root, "workitems/PROJ-123/.workflow-transaction/manifest.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
