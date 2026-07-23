import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materialize } from "../src/lib/materialize.js";
import { createStandardPreset } from "../src/lib/presets.js";
import { previewUninstall, uninstall } from "../src/lib/uninstall.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "saber-uninstall-v4-"));
  const config = createStandardPreset();
  config.roleProfiles = [];
  config.externalAssets = { schemaVersion: 1, assets: [] };
  config.mcp.servers = [{
    id: "reader",
    transport: "stdio",
    command: "node",
    args: ["reader.js"],
    env: [],
    tools: [{ name: "read", capability: "jira.read" }],
  }];
  await mkdir(join(root, "skills/saber"), { recursive: true });
  await writeFile(join(root, "skills/saber/SKILL.md"), "---\nname: saber\ndescription: fixture\n---\n", "utf8");
  return { root, config };
}

test("uninstall previews are random, single-use, and bound to current targets", async () => {
  const { root, config } = await fixture();
  try {
    await materialize(root, config, { tool: "codex", capabilities: ["jira.read"] });
    const first = await previewUninstall(root, { tool: "codex" });
    const second = await previewUninstall(root, { tool: "codex" });
    assert.notEqual(first.confirmationToken, second.confirmationToken);

    await writeFile(join(root, ".codex/config.toml"), `model = "gpt-5"\n${await readFile(join(root, ".codex/config.toml"), "utf8")}`, "utf8");
    await assert.rejects(
      () => uninstall(root, { tool: "codex", apply: true, confirm: first.confirmationToken }),
      /stale or invalid/u,
    );
    assert.equal((await lstat(join(root, ".agents/skills/saber--core-command--saber"))).isSymbolicLink(), true);

    const current = await previewUninstall(root, { tool: "codex" });
    await uninstall(root, { tool: "codex", apply: true, confirm: current.confirmationToken });
    await assert.rejects(
      () => uninstall(root, { tool: "codex", apply: true, confirm: current.confirmationToken }),
      /stale or invalid/u,
    );
    assert.match(await readFile(join(root, ".codex/config.toml"), "utf8"), /model = "gpt-5"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--all rolls back the whole batch when any mutation fails", async () => {
  const { root, config } = await fixture();
  try {
    await materialize(root, config, { tool: "codex", capabilities: ["jira.read"] });
    await materialize(root, config, { tool: "claude", capabilities: ["jira.read"] });
    const preview = await previewUninstall(root, { all: true });
    assert.equal(preview.targets.length, 2);

    await assert.rejects(
      () => uninstall(root, { all: true, apply: true, confirm: preview.confirmationToken }, {
        beforeMutation: async (kind, path) => {
          if (kind === "manifest" && path.includes("/claude/")) throw new Error("injected batch failure");
        },
      }),
      /injected batch failure/u,
    );
    for (const [tool, discovery] of [["codex", ".agents"], ["claude", ".claude"]] as const) {
      assert.equal((await lstat(join(root, `${discovery}/skills/saber--core-command--saber`))).isSymbolicLink(), true);
      assert.equal((await lstat(join(root, `.saber/runtime/materialize/${tool}/root.json`))).isFile(), true);
    }
    assert.match(await readFile(join(root, ".codex/config.toml"), "utf8"), /saber--reader/u);
    assert.match(await readFile(join(root, ".mcp.json"), "utf8"), /saber--reader/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall fails closed for symlinked preview storage and tampered manifests", async () => {
  for (const mode of ["preview-link", "manifest"] as const) {
    const { root, config } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "saber-uninstall-outside-"));
    try {
      await materialize(root, config, { tool: "codex", capabilities: ["jira.read"] });
      if (mode === "preview-link") {
        await mkdir(join(root, ".saber/runtime"), { recursive: true });
        await symlink(outside, join(root, ".saber/runtime/uninstall-previews"), "dir");
        await assert.rejects(() => previewUninstall(root, { tool: "codex" }), /preview storage is unsafe/u);
        assert.deepEqual(await readdir(outside), []);
      } else {
        const manifest = join(root, ".saber/runtime/materialize/codex/root.json");
        const value = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
        value.schemaVersion = 3;
        await writeFile(manifest, `${JSON.stringify(value)}\n`, "utf8");
        await assert.rejects(() => previewUninstall(root, { tool: "codex" }), /not managed by Saber/u);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
});
