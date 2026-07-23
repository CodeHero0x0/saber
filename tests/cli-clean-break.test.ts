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

test("CLI exposes unified init/workitem commands and rejects removed role and legacy commands", async () => {
  const help = await runCli(["--help"]);
  assert.match(help.stdout, /saber init --tool <codex\|claude\|opencode>/u);
  assert.match(help.stdout, /saber workitem advance/u);
  assert.match(help.stdout, /saber workitem pause/u);
  assert.match(help.stdout, /saber workitem resume/u);
  assert.doesNotMatch(help.stdout, /--role|saber (?:setup|use|demo|open|loop|next|handoff|decision)\b/u);

  const role = await runCli(["init", "--tool", "codex", "--role", "dev"]);
  assert.equal(role.exitCode, 2);
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
    config.roleProfiles = [];
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

test("README and checked-in assets describe only the clean-break entry path", async () => {
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  assert.match(readme, /npm run saber -- init --tool codex/u);
  assert.match(readme, /\/saber <KEY>/u);
  assert.match(readme, /uninstall --all\n[\s\S]*uninstall --all --apply --confirm <preview-token>/u);
  assert.doesNotMatch(readme, /SABER-20260723-00[123]|--role|saber (?:setup|use|demo|open|loop|next)\b/u);

  for (const path of [
    "src/commands/convenience.ts",
    "src/commands/mcp.ts",
    "src/lib/demo.ts",
    "src/lib/mcp/runtime.ts",
    "skills/saber-focus/SKILL.md",
    "templates/demo/DEMO-101/workitem.yaml",
  ]) {
    await assert.rejects(() => lstat(join(repositoryRoot, path)));
  }
});
