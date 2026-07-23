import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SaberError } from "../src/lib/errors.js";
import { withRepositoryLifecycleLock } from "../src/lib/lifecycle-lock.js";
import { materialize } from "../src/lib/materialize.js";
import { createStandardPreset } from "../src/lib/presets.js";
import type { RepositoryConfig } from "../src/lib/models.js";

async function writeSkill(root: string, path: string, name: string): Promise<void> {
  await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, path, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`,
    "utf8",
  );
}

async function fixture(): Promise<{ root: string; config: RepositoryConfig }> {
  const root = await mkdtemp(join(tmpdir(), "saber-materialize-v4-"));
  const config = createStandardPreset();
  config.externalAssets = {
    schemaVersion: 1,
    assets: [{
      id: "vendor",
      category: "skill-collection",
      description: "Fixture phase skills.",
      kind: "git",
      source: "https://example.test/vendor.git",
      packages: [
        { id: "ba", sourcePath: "skills/ba" },
        { id: "dev", sourcePath: "skills/dev" },
        { id: "qa", sourcePath: "skills/qa" },
      ],
    }],
  };
  config.workspace.projects = [{ name: "app", path: "projects/app", capabilities: ["mysql.read"] }];
  config.roleProfiles = [
    { id: "ba", teamSkills: ["phase-ba"], externalSkills: ["vendor/ba"], workflows: ["requirements"], capabilities: ["jira.read"] },
    { id: "dev", teamSkills: ["phase-dev"], externalSkills: ["vendor/dev"], workflows: ["develop", "fix"], capabilities: ["gitlab.mr.read"] },
    { id: "qa", teamSkills: ["phase-qa"], externalSkills: ["vendor/qa"], workflows: ["test", "fix"], capabilities: ["jira.read"] },
  ];
  config.mcp.servers = [{
    id: "reader",
    transport: "stdio",
    command: "node",
    args: ["tools/reader.js"],
    env: ["READER_TOKEN"],
    tools: [{ name: "read", capability: "jira.read" }],
  }];
  await writeSkill(root, "skills/saber", "saber");
  for (const id of ["phase-ba", "phase-dev", "phase-qa"]) await writeSkill(root, `skills/${id}`, id);
  for (const id of ["requirements", "develop", "fix", "test"]) await writeSkill(root, `workflows/${id}`, id);
  const packages = [];
  for (const id of ["ba", "dev", "qa"]) {
    const materializedPath = `.saber/external/saber-v1/skills/vendor/${id}`;
    await writeSkill(root, materializedPath, `vendor-${id}`);
    packages.push({ id: `vendor/${id}`, category: "skill-collection", materializedPath });
  }
  await mkdir(join(root, ".saber/external/saber-v1"), { recursive: true });
  await writeFile(
    join(root, ".saber/external/saber-v1/manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, managedBy: "saber", packages }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(root, "projects/app"), { recursive: true });
  return { root, config };
}

test("all supported tools receive one command and every phase asset without role context", async () => {
  const { root, config } = await fixture();
  try {
    for (const tool of ["codex", "claude", "opencode"] as const) {
      const result = await materialize(root, config, { tool });
      assert.deepEqual(result.coreCommands, ["saber"]);
      assert.deepEqual(new Set(result.workflows), new Set(["requirements", "develop", "fix", "test"]));
      assert.equal(result.projections.some(({ name }) => name.includes("--context--")), false);
      assert.equal(result.projections.some(({ name }) => name.includes("saber-focus")), false);
      assert.equal(await lstat(join(root, result.discoveryRoot, "saber--core-command--saber")).then((status) => status.isSymbolicLink()), true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project materialize stays inside the selected independent repository", async () => {
  const { root, config } = await fixture();
  try {
    const result = await materialize(root, config, { tool: "claude", project: "app" });
    assert.equal(result.project, "app");
    assert.equal(result.discoveryRoot, "projects/app/.claude/skills");
    assert.equal(await lstat(join(root, "projects/app/.claude/skills/saber--core-command--saber")).then((status) => status.isSymbolicLink()), true);
    assert.equal(await lstat(join(root, ".saber/runtime/materialize/claude/app.json")).then((status) => status.isFile()), true);
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
      await assert.rejects(
        () => materialize(root, config, { tool: "codex" }),
        (error: unknown) => error instanceof SaberError && /already active/u.test(error.message),
      );
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("materialize refuses a symlinked discovery parent without touching its target", async () => {
  const { root, config } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "saber-materialize-outside-"));
  try {
    await symlink(outside, join(root, ".agents"), "dir");
    await assert.rejects(
      () => materialize(root, config, { tool: "codex" }),
      (error: unknown) => error instanceof SaberError && /unsafe parent/u.test(error.message),
    );
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
        await writeFile(join(root, ".saber/runtime/materialize/codex/root.json"), '{"schemaVersion":3}\n', "utf8");
      } else {
        await mkdir(join(root, ".codex"), { recursive: true });
        await writeFile(
          join(root, ".codex/config.toml"),
          '[mcp_servers.saber--reader]\ncommand = "user-owned"\n',
          "utf8",
        );
      }
      await assert.rejects(() => materialize(root, config, { tool: "codex" }), SaberError);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("materialize rolls back prior projections when a managed Git exclude path is unsafe", async () => {
  const { root, config } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "saber-git-exclude-outside-"));
  try {
    const first = await materialize(root, config, { tool: "codex" });
    const manifestBefore = await readFile(join(root, first.manifestPath), "utf8");
    await mkdir(join(root, ".git"), { recursive: true });
    await symlink(outside, join(root, ".git/info"), "dir");

    await assert.rejects(
      () => materialize(root, config, { tool: "codex" }),
      (error: unknown) => error instanceof SaberError && /unsafe parent/u.test(error.message),
    );
    assert.equal(
      await lstat(join(root, ".agents/skills/saber--core-command--saber")).then((status) => status.isSymbolicLink()),
      true,
    );
    assert.equal(await readFile(join(root, first.manifestPath), "utf8"), manifestBefore);
    await assert.rejects(() => lstat(join(outside, "exclude")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
