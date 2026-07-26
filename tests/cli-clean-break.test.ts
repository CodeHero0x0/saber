import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { SaberError } from "../src/lib/errors.js";
import { createStandardPreset } from "../src/lib/presets.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "saber-init-clean-break-"));
  await writeFile(join(root, "saber.local.example.yaml"), "schemaVersion: 2\ndefaults: {}\nprojects: {}\nextensions: {}\nmcp: { servers: [] }\n", "utf8");
  return root;
}

test("CLI exposes unified init and minimal workitem commands", async () => {
  const help = await runCli(["--help"]);
  assert.match(help.stdout, /saber init \[--tool <codex\|claude\|opencode>\]/u);
  assert.match(help.stdout, /saber workitem create/u);
  assert.match(help.stdout, /saber workitem status/u);
  assert.doesNotMatch(help.stdout, /--role|saber workitem (?:advance|pause|resume|drift)\b/u);

  const role = await runCli(["init", "--tool", "codex", "--role", "dev"]);
  assert.equal(role.exitCode, 2);
  for (const command of [
    ["init", "--tool", "codex", "--project", "app"],
    ["materialize", "--tool", "codex", "--project", "app"],
    ["uninstall", "--tool", "codex", "--project", "app"],
  ]) {
    const result = await runCli(command);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /unknown flag/u);
  }
  for (const command of ["setup", "use", "demo", "open", "loop", "next", "handoff", "decision", "mcp"]) {
    const result = await runCli([command]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Unknown command/u);
  }
});

test("init removes only a local config it created when initialization fails", async () => {
  for (const existing of [false, true]) {
    const root = await fixture();
    const config = createStandardPreset();
    config.externalAssets = { schemaVersion: 1, assets: [] };
    config.skillSet = { team: [], external: [] };
    try {
      if (existing) await writeFile(join(root, "saber.local.yaml"), "schemaVersion: 2\n# keep\n", "utf8");
      const result = await runCli(["init", "--tool", "codex"], {
        cwd: root,
        dependencies: {
          initCommand: {
            loadConfig: async () => config,
            planExternal: async () => [],
            updateExternal: async () => undefined,
            runMaterialize: async () => { throw new SaberError("injected materialize failure", 2); },
          },
        },
      });
      assert.equal(result.exitCode, 2);
      if (existing) {
        assert.match(await readFile(join(root, "saber.local.yaml"), "utf8"), /# keep/u);
      } else {
        await assert.rejects(() => lstat(join(root, "saber.local.yaml")));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("README presents only the public Saber introduction and use path", async () => {
  const readme = (await readFile(join(repositoryRoot, "README.md"), "utf8")).replace(/\r\n/gu, "\n");
  assert.match(readme, /团队知识 Git 仓/u);
  assert.match(readme, /为什么使用 Saber/u);
  assert.match(readme, /## 功能/u);
  assert.match(readme, /## 使用/u);
  assert.match(readme, /saber-v0\.1\.1-darwin-arm64/u);
  assert.match(readme, /\.\/bin\/saber init --tool codex/u);
  assert.match(readme, /业务仓中的客户规则始终优先/u);
  assert.doesNotMatch(readme, /requirements\.md|plan\.md|progress\.md|三文件工作项|--role|saber workitem (?:advance|pause|resume|drift)\b|npm run saber/u);

  for (const path of [
    "src/commands/convenience.ts",
    "src/commands/mcp.ts",
    "src/lib/demo.ts",
    "src/lib/mcp/runtime.ts",
    "skills/saber-focus/SKILL.md",
    "templates/workitem/workitem.yaml",
    "templates/workitem/requirements.md",
    "templates/workitem/plan.md",
    "templates/workitem/progress.md",
    "workitems/mysql-mcp-integration",
    "workitems/saber-natural-language-router",
    "workitems/EXAMPLE-DICTIONARY-QUERY.md",
    "project-knowledge/backend-dictionary-query.md",
    "team-contracts/tc-context-minimization.md",
    "customer-sources/index.yaml",
    "docs/superpowers/specs/2026-07-26-saber-public-reset-design.md",
  ]) {
    await assert.rejects(() => lstat(join(repositoryRoot, path)));
  }
});
