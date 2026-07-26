import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { createStandardPreset } from "../src/lib/presets.js";
import { createWorkitem, getWorkitemStatus } from "../src/lib/workitems.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "saber-router-"));
  const config = createStandardPreset();
  config.skillSet = { team: [], external: [] };
  config.externalAssets = { schemaVersion: 1, assets: [] };
  config.workspace.projects = [{ name: "app", path: "projects/app" }];
  for (const command of ["saber", "saber-superpower", "saber-openspec", "saber-grill", "saber-grill-with-docs"]) {
    await mkdir(join(root, `skills/${command}`), { recursive: true });
    await writeFile(join(root, `skills/${command}/SKILL.md`), `---\nname: ${command}\ndescription: router\n---\n`, "utf8");
  }
  await mkdir(join(root, "projects/app"), { recursive: true });
  await writeFile(join(root, "saber.local.example.yaml"), "schemaVersion: 2\ndefaults: {}\nprojects: {}\nextensions: {}\nmcp: { servers: [] }\n", "utf8");
  return { root, config };
}

test("init materializes all Saber method commands at the workspace root", async () => {
  const { root, config } = await fixture();
  try {
    const result = await runCli(["init", "--tool", "codex", "--json"], {
      cwd: root,
      dependencies: { initCommand: { loadConfig: async () => config, planExternal: async () => [], updateExternal: async () => undefined } },
    });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /"tool": "codex"/u);
    assert.match(await readFile(join(root, ".agents/skills/saber--core-command--saber/SKILL.md"), "utf8"), /name: saber/u);
    assert.match(await readFile(join(root, ".agents/skills/saber--core-command--saber-openspec/SKILL.md"), "utf8"), /name: saber-openspec/u);
    assert.equal((await readdir(join(root, ".agents/skills"))).filter((name) => name.startsWith("saber--core-command--")).length, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workitems use one Markdown file without a state machine", async () => {
  const { root } = await fixture();
  try {
    const workitem = await createWorkitem(root, {
      source: { kind: "chat", title: "支持自然语言路由", content: "让 /saber 根据请求选择技能。" },
      repositories: [{ id: "app", path: "projects/app" }],
      now: new Date("2026-07-24T00:00:00.000Z"),
    });
    assert.equal(workitem.key, "支持自然语言路由");
    assert.equal(workitem.path, "workitems/支持自然语言路由.md");
    const status = await getWorkitemStatus(root, workitem.key);
    assert.equal(status.state, "valid");
    assert.equal(status.path, "workitems/支持自然语言路由.md");
    const content = await readFile(join(root, workitem.path), "utf8");
    assert.match(content, /# 原始输入/u);
    assert.doesNotMatch(content, /stage:|role:|nextStep:|allowedAction:/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
