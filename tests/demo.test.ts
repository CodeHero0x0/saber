import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse } from "yaml";

import { runCli } from "../src/cli.js";
import { createDemoWorkitem } from "../src/lib/demo.js";
import { getWorkitemStatus } from "../src/lib/workitems.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("completed DEMO-101 records every BA Dev QA stage and one fix loop", async () => {
  const root = join(repositoryRoot, "examples", "mock-project");
  const report = await getWorkitemStatus(root, "DEMO-101");

  assert.equal(report.workflow.state, "done");
  assert.equal(report.workflow.iteration, 1);
  assert.deepEqual(
    report.workflow.history.map(({ role, result, to }) => ({ role, result, to })),
    [
      { role: "ba", result: "ready", to: "dev-build" },
      { role: "dev", result: "ready", to: "qa-verify" },
      { role: "qa", result: "fail", to: "dev-fix" },
      { role: "dev", result: "ready", to: "qa-verify" },
      { role: "qa", result: "pass", to: "ba-accept" },
      { role: "ba", result: "accept", to: "done" },
    ],
  );
  assert.equal(report.handoffCount, 6);
  for (const artifact of ["requirements.md", "design.md", "plan.md", "tests.md", "acceptance.md"]) {
    const content = await readFile(join(root, "workitems", "DEMO-101", artifact), "utf8");
    assert.match(content, /[\u4E00-\u9FFF]/u, `${artifact} should explain the role output in Chinese`);
  }
});

test("demo assets contain parseable YAML and no credential-bearing URLs", async () => {
  const yamlFiles = [
    "examples/mock-project/saber.yaml",
    "examples/mock-project/workitems/DEMO-101/workitem.yaml",
    "examples/mock-project/workitems/DEMO-101/repositories.yaml",
    "templates/demo/DEMO-101/workitem.yaml",
    "templates/demo/DEMO-101/repositories.yaml",
  ];
  for (const path of yamlFiles) {
    const content = await readFile(join(repositoryRoot, path), "utf8");
    assert.ok(parse(content), `${path} must contain parseable YAML`);
  }

  const assetFiles = [
    ...await filesBelow(join(repositoryRoot, "examples", "mock-project")),
    ...await filesBelow(join(repositoryRoot, "templates", "demo")),
  ];
  for (const path of assetFiles) {
    const content = await readFile(path, "utf8");
    assert.doesNotMatch(content, /(?:ghp_|glpat-|sk-[A-Za-z0-9]|https?:\/\/[^\s/@]+:[^\s/@]+@)/u);
    for (const url of content.match(/https:\/\/[^\s]+/gu) ?? []) {
      assert.match(url, /\.example\.test(?:\/|$)/u, `${path} contains a non-example URL`);
    }
  }
});

test("demo command creates a fresh BA-first workitem and open plus loop can read it", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-demo-"));
  try {
    const created = await runCli(["demo", "--json"], { cwd: root });
    assert.equal(created.exitCode, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), { key: "DEMO-101", path: "workitems/DEMO-101" });

    const opened = await runCli(["open", "DEMO-101"], { cwd: root });
    const loop = await runCli(["loop", "DEMO-101"], { cwd: root });
    assert.equal(opened.exitCode, 0, opened.stderr);
    assert.match(opened.stdout, /State: ba-clarify/u);
    assert.match(opened.stdout, /Role: ba/u);
    assert.equal(loop.exitCode, 0, loop.stderr);
    assert.match(loop.stdout, /\* ba-clarify/u);
    assert.match(loop.stdout, /History: none/u);
    await access(join(root, "workitems", "DEMO-101", "acceptance.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("demo refuses unknown ids, existing workitems, and an escaping workitems symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-demo-safe-"));
  const outside = await mkdtemp(join(tmpdir(), "saber-demo-outside-"));
  try {
    const unknown = await runCli(["demo", "OTHER-1"], { cwd: root });
    assert.equal(unknown.exitCode, 2);

    await createDemoWorkitem(root);
    const requirements = join(root, "workitems", "DEMO-101", "requirements.md");
    await writeFile(requirements, "个人修改，不能覆盖。\n", "utf8");
    const duplicate = await runCli(["demo"], { cwd: root });
    assert.equal(duplicate.exitCode, 2);
    assert.equal(await readFile(requirements, "utf8"), "个人修改，不能覆盖。\n");

    const linkedRoot = await mkdtemp(join(tmpdir(), "saber-demo-linked-"));
    try {
      await symlink(outside, join(linkedRoot, "workitems"), "dir");
      const escaped = await runCli(["demo"], { cwd: linkedRoot });
      assert.equal(escaped.exitCode, 2);
      await assert.rejects(access(join(outside, "DEMO-101")), { code: "ENOENT" });
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }

    const internalLinkedRoot = await mkdtemp(join(tmpdir(), "saber-demo-internal-link-"));
    try {
      await mkdir(join(internalLinkedRoot, "redirected"));
      await symlink("redirected", join(internalLinkedRoot, "workitems"), "dir");
      const redirected = await runCli(["demo"], { cwd: internalLinkedRoot });
      assert.equal(redirected.exitCode, 2);
      await assert.rejects(access(join(internalLinkedRoot, "redirected", "DEMO-101")), { code: "ENOENT" });
    } finally {
      await rm(internalLinkedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
