import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { loadRepositoryConfig } from "../src/lib/config.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function acceptanceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "saber-acceptance-"));
  await cp(join(repositoryRoot, "saber.yaml"), join(root, "saber.yaml"));
  for (const directory of ["roles", "workflows", "skills"]) {
    await cp(join(repositoryRoot, directory), join(root, directory), { recursive: true });
  }
  return root;
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
        "--jira-url",
        "https://jira.example.test/browse/PROJ-123",
        "--fingerprint",
        "sha256:acceptance",
        "--updated-at",
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
        "sha256:acceptance",
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
