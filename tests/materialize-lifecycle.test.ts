import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SaberError } from "../src/lib/errors.js";
import { gitCommand, runSafeProcess } from "../src/lib/git.js";
import { withRepositoryLifecycleLock } from "../src/lib/lifecycle-lock.js";
import { materialize } from "../src/lib/materialize.js";
import { createStandardPreset } from "../src/lib/presets.js";
import type { RepositoryConfig } from "../src/lib/models.js";

async function writeSkill(root: string, path: string, name: string): Promise<void> {
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`, "utf8");
}

async function git(root: string, args: string[]): Promise<void> {
  const result = await runSafeProcess(gitCommand(args, root));
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed`);
}

async function fixture(): Promise<{ root: string; config: RepositoryConfig }> {
  const root = await mkdtemp(join(tmpdir(), "saber-materialize-v5-"));
  const config = createStandardPreset();
  config.externalAssets = {
    schemaVersion: 1,
    assets: [{
      id: "vendor",
      category: "skill-collection",
      description: "Fixture routing skill.",
      kind: "git",
      source: "https://example.test/vendor.git",
      packages: [{ id: "router-helper", sourcePath: "skills/router-helper" }],
    }],
  };
  config.skillSet = { team: ["router-helper"], external: ["vendor/router-helper"] };
  config.workspace.projects = [{ name: "app", path: "projects/app" }];
  config.mcp.servers = [{
    id: "reader",
    transport: "stdio",
    command: "node",
    args: ["tools/reader.js"],
    env: ["READER_TOKEN"],
    tools: [{ name: "read", capability: "jira.read" }],
  }];
  for (const command of ["saber", "saber-superpower", "saber-openspec", "saber-grill", "saber-grill-with-docs"]) {
    await writeSkill(root, `skills/${command}`, command);
  }
  await writeSkill(root, "skills/router-helper", "router-helper");
  const materializedPath = ".saber/external/saber-v1/skills/vendor/router-helper";
  await writeSkill(root, materializedPath, "vendor-router-helper");
  await mkdir(join(root, ".saber/external/saber-v1"), { recursive: true });
  await writeFile(join(root, ".saber/external/saber-v1/manifest.json"), `${JSON.stringify({ schemaVersion: 1, managedBy: "saber", packages: [{ id: "vendor/router-helper", category: "skill-collection", materializedPath }] }, null, 2)}\n`, "utf8");
  await mkdir(join(root, "projects/app"), { recursive: true });
  await writeFile(join(root, ".env"), "READER_TOKEN=fixture-token\n", "utf8");
  return { root, config };
}

test("all supported tools receive the Saber root command set and shared skill set", async () => {
  const { root, config } = await fixture();
  try {
    for (const tool of ["codex", "claude", "opencode"] as const) {
      const result = await materialize(root, config, { tool });
      assert.equal(result.schemaVersion, 6);
      assert.deepEqual(result.coreCommands, ["saber", "saber-superpower", "saber-openspec", "saber-grill", "saber-grill-with-docs"]);
      assert.deepEqual(result.teamSkills, ["router-helper"]);
      assert.deepEqual(result.externalSkills, ["vendor/router-helper"]);
      assert.equal(result.projections.some(({ name }) => name.includes("workflow")), false);
      for (const command of result.coreCommands) {
        assert.equal(await lstat(join(root, result.discoveryRoot, `saber--core-command--${command}`)).then((status) => status.isSymbolicLink()), true);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialize writes literal local MCP environment values for every supported tool", async () => {
  const { root, config } = await fixture();
  try {
    await writeFile(join(root, ".env"), "READER_TOKEN=fixture-token\nUNRELATED_TOKEN=must-not-leak\n", "utf8");
    await materialize(root, config, { tool: "codex" });
    await materialize(root, config, { tool: "claude" });
    await materialize(root, config, { tool: "opencode" });

    const [codex, claude, opencode] = await Promise.all([
      readFile(join(root, ".codex/config.toml"), "utf8"),
      readFile(join(root, ".mcp.json"), "utf8"),
      readFile(join(root, "opencode.json"), "utf8"),
    ]);
    assert.match(codex, /READER_TOKEN = "fixture-token"/u);
    assert.match(claude, /"READER_TOKEN": "fixture-token"/u);
    assert.match(opencode, /"READER_TOKEN": "fixture-token"/u);
    assert.doesNotMatch(codex, /env_vars|UNRELATED_TOKEN/u);
    assert.doesNotMatch(claude, /\$\{READER_TOKEN\}|UNRELATED_TOKEN/u);
    assert.doesNotMatch(opencode, /\{env:READER_TOKEN\}|UNRELATED_TOKEN/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialize refuses to write credentials into a Git-tracked tool configuration", async () => {
  const { root, config } = await fixture();
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "fixture@example.test"]);
    await git(root, ["config", "user.name", "Fixture"]);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex/config.toml"), 'model = "user-owned"\n', "utf8");
    await git(root, ["add", ".codex/config.toml"]);

    await assert.rejects(
      () => materialize(root, config, { tool: "codex" }),
      /refuses to write credentials into a Git-tracked tool configuration/u,
    );
    assert.equal(await readFile(join(root, ".codex/config.toml"), "utf8"), 'model = "user-owned"\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialize stays in the Saber root even when business repositories are configured", async () => {
  const { root, config } = await fixture();
  try {
    const result = await materialize(root, config, { tool: "claude" });
    assert.equal(result.discoveryRoot, ".claude/skills");
    assert.equal(await lstat(join(root, ".claude/skills/saber--core-command--saber")).then((status) => status.isSymbolicLink()), true);
    assert.equal(await lstat(join(root, ".saber/runtime/materialize/claude/root.json")).then((status) => status.isFile()), true);
    await assert.rejects(() => lstat(join(root, "projects/app/.claude")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rematerialize replaces only prior Saber-owned MCP entries and keeps user config", async () => {
  const { root, config } = await fixture();
  try {
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex/config.toml"), 'model = "gpt-5"\n', "utf8");
    await materialize(root, config, { tool: "codex" });
    config.mcp.servers = [];
    await materialize(root, config, { tool: "codex" });
    const text = await readFile(join(root, ".codex/config.toml"), "utf8");
    assert.match(text, /model = "gpt-5"/u);
    assert.doesNotMatch(text, /saber--reader/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialize is serialized by the repository lifecycle lock", async () => {
  const { root, config } = await fixture();
  try {
    await withRepositoryLifecycleLock(root, async () => {
      await assert.rejects(() => materialize(root, config, { tool: "codex" }), (error: unknown) => error instanceof SaberError && /already active/u.test(error.message));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialize refuses a symlinked discovery parent without touching its target", async () => {
  const { root, config } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "saber-materialize-outside-"));
  try {
    await symlink(outside, join(root, ".agents"), "dir");
    await assert.rejects(() => materialize(root, config, { tool: "codex" }), (error: unknown) => error instanceof SaberError && /unsafe parent/u.test(error.message));
    await assert.rejects(() => lstat(join(outside, "skills/saber--core-command--saber")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("old runtime manifests and user-owned managed names fail closed", async () => {
  for (const conflict of ["old-manifest", "managed-name"] as const) {
    const { root, config } = await fixture();
    try {
      if (conflict === "old-manifest") {
        await mkdir(join(root, ".saber/runtime/materialize/codex"), { recursive: true });
        await writeFile(join(root, ".saber/runtime/materialize/codex/root.json"), '{"schemaVersion":4}\n', "utf8");
      } else {
        await mkdir(join(root, ".codex"), { recursive: true });
        await writeFile(join(root, ".codex/config.toml"), '[mcp_servers.saber--reader]\ncommand = "user-owned"\n', "utf8");
      }
      await assert.rejects(() => materialize(root, config, { tool: "codex" }), SaberError);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
