import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";

import { runCli } from "../src/cli.js";
import { loadRepositoryConfig } from "../src/lib/config.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function acceptanceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "saber-acceptance-"));
  await cp(join(repositoryRoot, "saber.yaml"), join(root, "saber.yaml"));
  for (const directory of ["roles", "workflows", "skills"]) {
    await cp(join(repositoryRoot, directory), join(root, directory), { recursive: true });
  }
  const configPath = join(root, "saber.yaml");
  const config = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.mcp = {
    servers: [
      {
        id: "acceptance",
        transport: "stdio",
        command: "node",
        args: ["tools/mock-mcp.js"],
        env: {},
        tools: [{ name: "read_merge_request", capability: "gitlab.mr.read" }],
      },
    ],
  };
  await writeFile(configPath, stringify(config), "utf8");
  return root;
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}

async function materializeExternalFixture(root: string): Promise<void> {
  const config = await loadRepositoryConfig(root);
  const packages: Array<Record<string, unknown>> = [];
  for (const asset of config.externalAssets.assets) {
    for (const selectedPackage of asset.packages) {
      const materializedPath = `.saber/external/saber-v1/skills/${asset.id}/${selectedPackage.id}`;
      await mkdir(join(root, materializedPath), { recursive: true });
      await writeFile(
        join(root, materializedPath, "SKILL.md"),
        `---\nname: ${selectedPackage.id}\ndescription: Acceptance fixture.\n---\n`,
        "utf8",
      );
      packages.push({
        id: `${asset.id}/${selectedPackage.id}`,
        category: asset.category,
        materializedPath,
        revision: "acceptance-fixture",
      });
    }
  }
  await writeFile(
    join(root, ".saber/external/saber-v1/manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, managedBy: "saber", packages })}\n`,
    "utf8",
  );
}

test("approved Saber MVP path works in a fresh temporary workspace", async () => {
  const root = await acceptanceRoot();
  try {
    await materializeExternalFixture(root);

    const intake = "# PROJ-123 已确认需求\n\n前后端共同支持订单范围确认。\n";
    const fingerprint = `sha256:${createHash("sha256").update(intake).digest("hex")}`;
    await writeFile(join(root, "intake.md"), intake, "utf8");

    const validate = await runCli(["validate", "--json"], { cwd: root });
    assert.equal(validate.exitCode, 0, validate.stdout);

    const doctor = await runCli(["doctor", "--json"], {
      cwd: root,
      dependencies: {
        doctorCommand: {
          env: {},
          runner: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
        },
      },
    });
    assert.equal(doctor.exitCode, 0, doctor.stdout);
    const doctorReport = JSON.parse(doctor.stdout) as {
      connectors: Array<{ state: string }>;
    };
    assert.ok(doctorReport.connectors.every((connector) => connector.state === "not-configured"));

    const create = await runCli(
      [
        "workitem",
        "create",
        "PROJ-123",
        "--source-type",
        "jira",
        "--source-title",
        "PROJ-123 订单范围确认",
        "--source-file",
        "intake.md",
        "--source-origin",
        "https://jira.example.test/browse/PROJ-123",
        "--captured-at",
        "2026-07-22T08:30:00Z",
        "--project",
        "frontend",
        "--project",
        "backend",
        "--json",
      ],
      { cwd: root },
    );
    assert.equal(create.exitCode, 0, create.stdout);
    const handoff = await runCli(
      [
        "workitem",
        "handoff",
        "PROJ-123",
        "--role",
        "ba",
        "--summary",
        "Requirements confirmed",
        "--risk",
        "Interface compatibility",
        "--next",
        "Dev design",
        "--fingerprint",
        fingerprint,
        "--json",
      ],
      { cwd: root },
    );
    assert.equal(handoff.exitCode, 0, handoff.stdout);

    for (const tool of ["codex", "claude", "opencode"]) {
      const loaded = await runCli(
        ["materialize", "--tool", tool, "--role", "dev", "--json"],
        { cwd: root },
      );
      assert.equal(loaded.exitCode, 0, loaded.stdout);
    }

    for (const path of [".codex/config.toml", ".mcp.json", "opencode.json"]) {
      assert.equal(await pathMissing(join(root, path)), false, path);
    }
    const codexPreview = await runCli(["uninstall", "--tool", "codex", "--json"], { cwd: root });
    assert.equal(codexPreview.exitCode, 0, codexPreview.stdout);
    const codexToken = (JSON.parse(codexPreview.stdout) as {
      plan: { confirmationToken: string };
    }).plan.confirmationToken;
    const codexUninstall = await runCli(
      ["uninstall", "--tool", "codex", "--apply", "--confirm", codexToken, "--json"],
      { cwd: root },
    );
    assert.equal(codexUninstall.exitCode, 0, codexUninstall.stdout);
    assert.equal(await pathMissing(join(root, ".codex/config.toml")), true);

    const allPreview = await runCli(["uninstall", "--all", "--json"], { cwd: root });
    assert.equal(allPreview.exitCode, 0, allPreview.stdout);
    const allToken = (JSON.parse(allPreview.stdout) as {
      plan: { confirmationToken: string; targets: unknown[] };
    }).plan;
    assert.equal(allToken.targets.length, 2);
    const allUninstall = await runCli(
      ["uninstall", "--all", "--apply", "--confirm", allToken.confirmationToken, "--json"],
      { cwd: root },
    );
    assert.equal(allUninstall.exitCode, 0, allUninstall.stdout);
    assert.equal(await pathMissing(join(root, ".mcp.json")), true);
    assert.equal(await pathMissing(join(root, "opencode.json")), true);

    await writeFile(
      join(root, "jira-update.json"),
      JSON.stringify({ key: "PROJ-123", fields: { summary: "Confirmed scope" } }),
      "utf8",
    );
    const preview = await runCli(
      ["action", "preview", "jira.update", "--payload", "jira-update.json", "--json"],
      {
        cwd: root,
        dependencies: {
          actionCommand: {
            env: {
              JIRA_BASE_URL: "https://jira.example.test",
              JIRA_ACCOUNT_ID: "ba@example.test",
            },
          },
        },
      },
    );
    assert.equal(preview.exitCode, 0, preview.stdout);
    const rejected = await runCli(
      [
        "action",
        "execute",
        "jira.update",
        "--payload",
        "jira-update.json",
        "--confirm",
        "sha256:wrong",
        "--json",
      ],
      {
        cwd: root,
        dependencies: {
          actionCommand: {
            env: {
              JIRA_BASE_URL: "https://jira.example.test",
              JIRA_ACCOUNT_ID: "ba@example.test",
              JIRA_API_TOKEN: "never-sent",
            },
          },
        },
      },
    );
    assert.equal(rejected.exitCode, 3);

    const external = await runCli(["external", "update", "--json"], { cwd: root });
    assert.equal(external.exitCode, 0, external.stdout);
    assert.equal((JSON.parse(external.stdout) as { mode: string }).mode, "dry-run");

    const demo = await runCli(["demo", "--json"], { cwd: root });
    assert.equal(demo.exitCode, 0, demo.stderr);
    const opened = await runCli(["open", "DEMO-101", "--json"], { cwd: root });
    assert.equal(opened.exitCode, 0, opened.stdout);
    assert.equal((JSON.parse(opened.stdout) as { workflow: { state: string } }).workflow.state, "ba-clarify");
    const loop = await runCli(["loop", "DEMO-101"], { cwd: root });
    assert.equal(loop.exitCode, 0, loop.stderr);
    assert.match(loop.stdout, /Current: \* ba-clarify/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
