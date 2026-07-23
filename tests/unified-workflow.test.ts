import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { stringify } from "yaml";

import { runCli } from "../src/cli.js";
import { createStandardPreset } from "../src/lib/presets.js";
import { materialize } from "../src/lib/materialize.js";
import { createWorkitem, advanceWorkitem, getWorkitemStatus } from "../src/lib/workitems.js";
import { previewUninstall, uninstall } from "../src/lib/uninstall.js";
import type { RepositoryConfig } from "../src/lib/models.js";

async function rootFixture(): Promise<{ root: string; config: RepositoryConfig }> {
  const root = await mkdtemp(join(tmpdir(), "saber-unified-"));
  const config = createStandardPreset();
  config.roleProfiles = [];
  config.externalAssets = { schemaVersion: 1, assets: [] };
  config.workspace.projects = [{ name: "app", path: "projects/app" }];
  config.mcp.servers = [{
    id: "team-tools",
    transport: "stdio",
    command: "node",
    args: ["tools/team-tools.js"],
    env: ["TEAM_TOKEN"],
    tools: [{ name: "read", capability: "jira.read" }],
  }];
  await mkdir(join(root, "skills/saber"), { recursive: true });
  await writeFile(join(root, "skills/saber/SKILL.md"), "---\nname: saber\ndescription: unified\n---\n", "utf8");
  await mkdir(join(root, "projects/app"), { recursive: true });
  return { root, config };
}

test("materialize projects one unified /saber command and native MCP config without a role", async () => {
  const { root, config } = await rootFixture();
  try {
    const result = await materialize(root, config, { tool: "codex", capabilities: ["jira.read"] });
    assert.equal(result.schemaVersion, 4);
    assert.deepEqual(result.coreCommands, ["saber"]);
    assert.equal(result.mcpServers[0], "team-tools");
    assert.ok(result.projections.every((projection) => projection.name.includes("saber--")));
    const native = await readFile(join(root, ".codex/config.toml"), "utf8");
    assert.match(native, /team-tools/u);
    assert.match(native, /env_vars = \[\s*"TEAM_TOKEN"\s*\]/u);
    assert.equal(await lstat(join(root, ".agents/skills/saber--core-command--saber" )).then((s) => s.isSymbolicLink()), true);
    assert.equal(await lstat(join(root, ".saber/runtime/materialize/codex/root.json")).then((s) => s.isFile()), true);
    const repeated = await materialize(root, config, { tool: "codex", capabilities: ["jira.read"] });
    assert.deepEqual(repeated.coreCommands, ["saber"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialize renders native environment references for all supported tools", async () => {
  const { root, config } = await rootFixture();
  config.mcp.servers.push({
    id: "remote-tools",
    transport: "http",
    url: "https://mcp.example.com/tools",
    headers: { Authorization: "REMOTE_TOKEN" },
    tools: [{ name: "query", capability: "mysql.read" }],
  });
  try {
    await materialize(root, config, { tool: "codex", capabilities: ["jira.read", "mysql.read"] });
    const codex = parseToml(await readFile(join(root, ".codex/config.toml"), "utf8")) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(codex.mcp_servers["saber--team-tools"]?.env_vars, ["TEAM_TOKEN"]);
    assert.deepEqual(codex.mcp_servers["saber--remote-tools"]?.env_http_headers, {
      Authorization: "REMOTE_TOKEN",
    });

    await materialize(root, config, { tool: "claude", capabilities: ["jira.read", "mysql.read"] });
    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(claude.mcpServers["saber--team-tools"]?.env, { TEAM_TOKEN: "${TEAM_TOKEN}" });
    assert.deepEqual(claude.mcpServers["saber--remote-tools"]?.headers, {
      Authorization: "${REMOTE_TOKEN}",
    });

    await materialize(root, config, { tool: "opencode", capabilities: ["jira.read", "mysql.read"] });
    const opencode = JSON.parse(await readFile(join(root, "opencode.json"), "utf8")) as {
      mcp: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(opencode.mcp["saber--team-tools"]?.environment, {
      TEAM_TOKEN: "{env:TEAM_TOKEN}",
    });
    assert.deepEqual(opencode.mcp["saber--remote-tools"]?.headers, {
      Authorization: "{env:REMOTE_TOKEN}",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workitem stages update history without role handoff directories", async () => {
  const { root } = await rootFixture();
  try {
    const metadata = await createWorkitem(root, {
      key: "SABER-20260723-001",
      source: { kind: "chat", title: "统一入口", content: "让任何成员可以继续工作。" },
      repositories: [{ name: "app", path: "projects/app" }],
    });
    assert.equal(metadata.workflow.state, "ba-clarify");
    const entries = await readdir(join(root, "workitems", metadata.key));
    assert.deepEqual(entries.sort(), ["design.md", "intake.md", "plan.md", "repositories.yaml", "requirements.md", "tests.md", "workitem.yaml"]);
    await advanceWorkitem(root, { key: metadata.key, result: "ready", summary: "需求已明确", risk: "none", next: "实现", fingerprint: metadata.source.fingerprint });
    const status = await getWorkitemStatus(root, metadata.key);
    assert.equal(status.workflow.state, "dev-build");
    assert.equal("handoffCount" in status, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uninstall removes only Saber-owned projections and native MCP entries", async () => {
  const { root, config } = await rootFixture();
  try {
    await materialize(root, config, { tool: "claude", capabilities: ["jira.read"] });
    const preview = await previewUninstall(root, { tool: "claude" });
    assert.equal(preview.targets.length, 1);
    const result = await uninstall(root, { tool: "claude", apply: true, confirm: preview.confirmationToken });
    assert.equal(result.applied, true);
    await assert.rejects(() => lstat(join(root, ".claude/skills/saber--core-command--saber")));
    const configText = await readFile(join(root, ".mcp.json"), "utf8").catch(() => "");
    assert.doesNotMatch(configText, /team-tools/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("init accepts only tool/project and exposes one built-in command", async () => {
  const { root } = await rootFixture();
  try {
    const config = createStandardPreset();
    config.roleProfiles = [];
    config.externalAssets = { schemaVersion: 1, assets: [] };
    config.workspace.projects = [{ name: "app", path: "projects/app" }];
    await writeFile(join(root, "saber.yaml"), stringify({ schemaVersion: 3, name: "Saber", workspace: { tools: { default: "codex" }, projects: [{ name: "app", path: "projects/app" }] }, externalSkills: { preset: "standard" }, mcp: { servers: [] } }), "utf8");
    await writeFile(join(root, "saber.local.example.yaml"), "schemaVersion: 2\ndefaults: {}\nprojects: {}\nextensions: {}\nmcp: { servers: [] }\n", "utf8");
    const result = await runCli(["init", "--tool", "codex", "--json"], { cwd: root, dependencies: { initCommand: { loadConfig: async () => config, planExternal: async () => [], updateExternal: async () => undefined } } });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /"tool": "codex"/u);
    assert.match(await readFile(join(root, ".agents/skills/saber--core-command--saber/SKILL.md"), "utf8"), /name: saber/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
