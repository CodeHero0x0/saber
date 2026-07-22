import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materialize } from "../src/lib/materialize.js";
import type { RepositoryConfig, ToolName } from "../src/lib/models.js";
import { previewUninstall, uninstall } from "../src/lib/uninstall.js";

const coreCommands = [
  "saber",
  "saber-intake",
  "saber-focus",
  "saber-status",
  "saber-refine",
  "saber-help",
] as const;

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "saber-uninstall-"));
  await mkdir(join(root, "projects/backend/.git"), { recursive: true });
  await writeFile(join(root, "projects/backend/user.txt"), "business source\n", "utf8");
  for (const name of coreCommands) {
    await mkdir(join(root, `skills/${name}`), { recursive: true });
    await writeFile(
      join(root, `skills/${name}/SKILL.md`),
      `---\nname: ${name}\ndescription: Test command.\n---\n\n# ${name}\n`,
      "utf8",
    );
  }
  await mkdir(join(root, ".saber/external/cache"), { recursive: true });
  await writeFile(join(root, ".saber/external/cache/preserved.txt"), "keep\n", "utf8");
  return root;
}

function configuration(): RepositoryConfig {
  const role = {
    teamSkills: [],
    externalSkills: [],
    workflows: [],
    capabilities: ["data.read"],
  } as const;
  return {
    saber: {
      schemaVersion: 1,
      name: "Saber uninstall fixture",
      safety: { externalWrites: "preview-and-confirm", forbiddenRiskLevels: ["L3"] },
    },
    workspace: {
      schemaVersion: 1,
      tools: { default: "codex", supported: ["codex", "claude", "opencode"] },
      projects: [{ name: "backend", path: "projects/backend", capabilities: ["data.read"] }],
    },
    capabilities: [{ id: "data.read", risk: "L0", kind: "read" }],
    connectors: [],
    externalAssets: { schemaVersion: 1, assets: [] },
    roleProfiles: [
      { id: "ba", ...role },
      { id: "dev", ...role },
      { id: "qa", ...role },
    ],
    mcp: {
      servers: [{
        id: "data",
        transport: "stdio",
        command: "node",
        args: ["tools/data.js"],
        env: {},
        tools: [{ name: "read_data", capability: "data.read" }],
      }],
    },
  };
}

async function install(root: string, tool: ToolName, project?: string): Promise<void> {
  await materialize(root, configuration(), {
    role: "dev",
    tool,
    ...(project === undefined ? {} : { project }),
  });
}

async function missing(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}

test("targeted preview and apply remove only manifest-owned state and are idempotent", async () => {
  const root = await temporaryRepository();
  try {
    await mkdir(join(root, ".codex"), { recursive: true });
    const userConfig = 'model = "gpt-5"\n';
    await writeFile(join(root, ".codex/config.toml"), userConfig, "utf8");
    await install(root, "codex");
    const updatedUserConfig = (await readFile(join(root, ".codex/config.toml"), "utf8")).replace(
      "# saber-managed-mcp-begin",
      'approval_policy = "never"\n\n# saber-managed-mcp-begin',
    );
    await writeFile(join(root, ".codex/config.toml"), updatedUserConfig, "utf8");

    const preview = await previewUninstall(root, { tool: "codex" });
    assert.equal(preview.targets.length, 1);
    assert.match(preview.confirmationToken, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(preview.targets[0]?.mcpEntries.map(({ id }) => id), ["saber--data"]);
    assert.deepEqual(preview.preserved, [
      "external-assets",
      "projects",
      "source-assets",
      "unmanaged-tool-configuration",
    ]);

    const result = await uninstall(root, {
      tool: "codex",
      apply: true,
      confirm: preview.confirmationToken,
    });
    assert.equal(result.applied, true);
    assert.equal(
      await readFile(join(root, ".codex/config.toml"), "utf8"),
      `${userConfig}\napproval_policy = "never"\n`,
    );
    assert.equal(await missing(join(root, ".saber/runtime/materialize/codex/root.json")), true);
    assert.equal(await missing(join(root, ".saber/runtime/mcp/codex/root/_active.json")), true);
    assert.equal(await missing(join(root, ".agents/skills/saber--context--dev")), true);
    assert.equal(await readFile(join(root, "projects/backend/user.txt"), "utf8"), "business source\n");
    assert.equal(await readFile(join(root, ".saber/external/cache/preserved.txt"), "utf8"), "keep\n");
    assert.match(await readFile(join(root, "skills/saber/SKILL.md"), "utf8"), /name: saber/u);

    const empty = await previewUninstall(root, { tool: "codex" });
    assert.deepEqual(empty.targets, []);
    const repeated = await uninstall(root, {
      tool: "codex",
      apply: true,
      confirm: empty.confirmationToken,
    });
    assert.equal(repeated.applied, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an all-target preview token becomes stale when another valid target appears", async () => {
  const root = await temporaryRepository();
  try {
    await install(root, "codex");
    const preview = await previewUninstall(root, { all: true });
    await install(root, "claude", "backend");
    await assert.rejects(
      () => uninstall(root, { all: true, apply: true, confirm: preview.confirmationToken }),
      /stale or invalid/u,
    );
    assert.equal((await lstat(join(root, ".agents/skills/saber--context--dev"))).isSymbolicLink(), true);
    assert.equal((await lstat(join(root, "projects/backend/.claude/skills/saber--context--dev"))).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one changed projection stops the complete all-target batch before mutation", async () => {
  const root = await temporaryRepository();
  try {
    await install(root, "codex");
    await install(root, "claude", "backend");
    const changed = join(root, "projects/backend/.claude/skills/saber--context--dev");
    await unlink(changed);
    await mkdir(changed);

    await assert.rejects(() => previewUninstall(root, { all: true }), /projection.*replaced/u);
    assert.equal((await lstat(join(root, ".agents/skills/saber--context--dev"))).isSymbolicLink(), true);
    assert.equal(await missing(join(root, ".saber/runtime/materialize/codex/root.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failure after the first target mutation rolls the entire batch back", async () => {
  const root = await temporaryRepository();
  try {
    await install(root, "codex");
    await install(root, "claude", "backend");
    const preview = await previewUninstall(root, { all: true });
    let toolConfigMutations = 0;
    await assert.rejects(
      () => uninstall(
        root,
        { all: true, apply: true, confirm: preview.confirmationToken },
        {
          beforeMutation: async (kind) => {
            if (kind === "tool-config" && ++toolConfigMutations === 2) {
              throw new Error("injected write failure");
            }
          },
        },
      ),
      /injected write failure/u,
    );
    for (const path of [
      ".saber/runtime/materialize/codex/root.json",
      ".saber/runtime/materialize/claude/backend.json",
      ".agents/skills/saber--context--dev",
      "projects/backend/.claude/skills/saber--context--dev",
    ]) assert.equal(await missing(join(root, path)), false);
    assert.match(await readFile(join(root, ".codex/config.toml"), "utf8"), /saber--data/u);
    assert.match(await readFile(join(root, "projects/backend/.mcp.json"), "utf8"), /saber--data/u);
    assert.equal(await missing(join(root, ".saber/runtime/transactions/uninstall.json")), true);
    await assert.rejects(
      () => uninstall(root, { all: true, apply: true, confirm: preview.confirmationToken }),
      /consumed|stale or invalid/u,
    );
    assert.equal(await missing(join(root, ".saber/runtime/materialize/codex/root.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("obsolete or symlinked manifests are never accepted as deletion authority", async () => {
  const root = await temporaryRepository();
  try {
    await install(root, "codex");
    const manifestPath = join(root, ".saber/runtime/materialize/codex/root.json");
    const original = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, original.replace('"schemaVersion": 3', '"schemaVersion": 2'), "utf8");
    await assert.rejects(() => previewUninstall(root, { tool: "codex" }), /not managed by Saber/u);

    await writeFile(manifestPath, original, "utf8");
    const backing = join(root, ".saber/runtime/materialize/codex/backing.json");
    await writeFile(backing, original, "utf8");
    await unlink(manifestPath);
    await symlink("backing.json", manifestPath);
    await assert.rejects(() => previewUninstall(root, { tool: "codex" }), /regular Saber-owned file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed generated context file stops uninstall", async () => {
  const root = await temporaryRepository();
  try {
    await install(root, "codex");
    await writeFile(
      join(root, ".saber/runtime/materialize/codex/root/context/SKILL.md"),
      "changed by user\n",
      "utf8",
    );
    await assert.rejects(
      () => previewUninstall(root, { tool: "codex" }),
      /context runtime does not match its manifest/u,
    );
    assert.equal((await lstat(join(root, ".agents/skills/saber--context--dev"))).isSymbolicLink(), true);
    assert.equal(await missing(join(root, ".saber/runtime/materialize/codex/root.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid scope and confirmation combinations fail before filesystem mutation", async () => {
  const root = await temporaryRepository();
  try {
    await assert.rejects(() => previewUninstall(root, {}), /--tool is required/u);
    await assert.rejects(() => previewUninstall(root, { all: true, tool: "codex" }), /cannot be combined/u);
    await assert.rejects(() => previewUninstall(root, { project: "backend" }), /--tool is required|requires --tool/u);
    await assert.rejects(() => uninstall(root, { tool: "codex", confirm: "x" }), /requires --apply/u);
    await assert.rejects(() => uninstall(root, { tool: "codex", apply: true }), /requires --confirm/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an active lifecycle lock prevents uninstall preview from recovering another operation", async () => {
  const root = await temporaryRepository();
  try {
    const transactionDirectory = join(root, ".saber/runtime/transactions");
    await mkdir(transactionDirectory, { recursive: true });
    await writeFile(join(root, "protected.txt"), "in progress\n", "utf8");
    await writeFile(
      join(transactionDirectory, "materialize--codex--root.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        managedBy: "saber",
        files: [{ path: "protected.txt", content: "before\n" }],
        links: [],
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(root, ".saber/runtime/lifecycle.lock"),
      `${JSON.stringify({
        schemaVersion: 1,
        managedBy: "saber",
        pid: process.pid,
        nonce: "active-test-owner",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      () => previewUninstall(root, { tool: "codex" }),
      /lifecycle operation is already active/u,
    );
    assert.equal(await readFile(join(root, "protected.txt"), "utf8"), "in progress\n");
    assert.equal(
      (await lstat(join(transactionDirectory, "materialize--codex--root.json"))).isFile(),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed lifecycle lock fails closed", async () => {
  const root = await temporaryRepository();
  try {
    await mkdir(join(root, ".saber/runtime"), { recursive: true });
    await writeFile(join(root, ".saber/runtime/lifecycle.lock"), "not-json\n", "utf8");
    await assert.rejects(
      () => previewUninstall(root, { tool: "codex" }),
      /lifecycle lock is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lifecycle lock is reclaimed only after its owner pid is gone", async () => {
  const root = await temporaryRepository();
  try {
    await mkdir(join(root, ".saber/runtime/transactions"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex/config.toml"), "in progress\n", "utf8");
    await writeFile(
      join(root, ".saber/runtime/transactions/materialize--codex--root.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        managedBy: "saber",
        operation: "materialize",
        tool: "codex",
        target: "root",
        scopes: [{
          tool: "codex",
          target: "root",
          projectPath: null,
          descriptors: [],
          projections: [],
        }],
        files: [{ path: ".codex/config.toml", content: "before\n" }],
        links: [],
        directories: [],
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(root, ".saber/runtime/lifecycle.lock"),
      `${JSON.stringify({
        schemaVersion: 1,
        managedBy: "saber",
        pid: 2_147_483_647,
        nonce: "stale-test-owner",
        createdAt: new Date(0).toISOString(),
      })}\n`,
      "utf8",
    );

    const preview = await previewUninstall(root, { tool: "codex" });
    assert.deepEqual(preview.targets, []);
    assert.equal(await readFile(join(root, ".codex/config.toml"), "utf8"), "before\n");
    assert.equal(await missing(join(root, ".saber/runtime/transactions/materialize--codex--root.json")), true);
    assert.equal(await missing(join(root, ".saber/runtime/lifecycle.lock")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown transaction filenames cannot restore arbitrary repository files", async () => {
  const root = await temporaryRepository();
  try {
    await writeFile(join(root, "README.md"), "keep me\n", "utf8");
    await mkdir(join(root, ".saber/runtime/transactions"), { recursive: true });
    await writeFile(
      join(root, ".saber/runtime/transactions/evil.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        managedBy: "saber",
        files: [{ path: "README.md", content: "owned\n" }],
        links: [],
        directories: [],
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      () => previewUninstall(root, { tool: "codex" }),
      /unmanaged content|transaction filename/u,
    );
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "keep me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall previews are random single-use records that cannot replay after reinstall", async () => {
  const root = await temporaryRepository();
  try {
    await install(root, "codex");
    const first = await previewUninstall(root, { tool: "codex" });
    const second = await previewUninstall(root, { tool: "codex" });
    assert.notEqual(first.confirmationToken, second.confirmationToken);
    const records = await readdir(join(root, ".saber/runtime/uninstall-previews"));
    assert.equal(records.filter((name) => name.endsWith(".json")).length, 2);
    for (const record of records) {
      const status = await lstat(join(root, ".saber/runtime/uninstall-previews", record));
      assert.equal(status.mode & 0o777, 0o600);
    }

    await uninstall(root, {
      tool: "codex",
      apply: true,
      confirm: first.confirmationToken,
    });
    await assert.rejects(
      () => uninstall(root, { tool: "codex", apply: true, confirm: first.confirmationToken }),
      /consumed|stale or invalid/u,
    );

    await install(root, "codex");
    await assert.rejects(
      () => uninstall(root, { tool: "codex", apply: true, confirm: first.confirmationToken }),
      /consumed|stale or invalid/u,
    );
    assert.equal(await missing(join(root, ".saber/runtime/materialize/codex/root.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall preview storage refuses a parent symlink outside the repository", async () => {
  const root = await temporaryRepository();
  const outside = await mkdtemp(join(tmpdir(), "saber-uninstall-preview-outside-"));
  try {
    await install(root, "codex");
    await symlink(outside, join(root, ".saber/runtime/uninstall-previews"), "dir");
    await assert.rejects(
      () => previewUninstall(root, { tool: "codex" }),
      /unsafe parent|preview.*unsafe|escapes/u,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("only one concurrent uninstall can consume a preview token", async () => {
  const root = await temporaryRepository();
  try {
    await install(root, "codex");
    const preview = await previewUninstall(root, { tool: "codex" });
    const results = await Promise.allSettled([
      uninstall(root, { tool: "codex", apply: true, confirm: preview.confirmationToken }),
      uninstall(root, { tool: "codex", apply: true, confirm: preview.confirmationToken }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    await assert.rejects(
      () => uninstall(root, { tool: "codex", apply: true, confirm: preview.confirmationToken }),
      /consumed|stale or invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
