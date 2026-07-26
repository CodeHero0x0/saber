import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { builtinSkillIds, ensureBuiltinSkills } from "../src/lib/builtin-skills.js";
import { workspaceDefaultAssetPaths } from "../src/lib/default-assets.js";

test("init without a tool creates a non-overwriting blank team workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-scaffold-"));
  try {
    const preserved = new Map<string, string>();
    for (const path of [...workspaceDefaultAssetPaths, ".env", "saber.local.yaml"]) {
      const content = `customer-maintained:${path}\n`;
      preserved.set(path, content);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, "utf8");
    }
    const result = await runCli(["init", "--json"], { cwd: root });
    assert.equal(result.exitCode, 0, result.stdout);
    const report = JSON.parse(result.stdout) as { ok: boolean; initializedTool: null; scaffold: { created: string[]; existing: string[] } };
    assert.equal(report.ok, true);
    assert.equal(report.initializedTool, null);
    assert.ok(report.scaffold.created.includes("customer-sources/index.yaml"));
    for (const [path, content] of preserved) {
      assert.ok(report.scaffold.existing.includes(path), path);
      assert.equal(await readFile(join(root, path), "utf8"), content, path);
    }
    assert.equal(await readFile(join(root, "customer-sources/index.yaml"), "utf8"), "schemaVersion: 1\nsources: []\n");
    assert.equal(await lstat(join(root, "skills")).catch(() => undefined), undefined);
    const builtins = await ensureBuiltinSkills(root);
    for (const id of builtinSkillIds) {
      assert.match(await readFile(join(root, builtins.rootPath, id, "SKILL.md"), "utf8"), /^---/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed built-in skills fail closed when locally modified", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-builtin-skills-"));
  try {
    const builtins = await ensureBuiltinSkills(root);
    await writeFile(join(root, builtins.rootPath, "saber", "SKILL.md"), "locally modified\n", "utf8");
    await assert.rejects(
      () => ensureBuiltinSkills(root),
      /managed built-in skill was modified: saber/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
