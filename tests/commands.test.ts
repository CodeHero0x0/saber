import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { validateRepositoryAssets } from "../src/commands/validate.js";
import type { RepositoryConfig } from "../src/lib/models.js";
import type { SafeProcessCommand, SafeProcessRunner } from "../src/lib/git.js";

function repositoryConfig(
  projects: RepositoryConfig["workspace"]["projects"] = [],
): RepositoryConfig {
  return {
    saber: {
      schemaVersion: 1,
      name: "Saber test",
      safety: { externalWrites: "preview-and-confirm", forbiddenRiskLevels: ["L3"] },
    },
    workspace: { schemaVersion: 1, tools: { default: "codex" }, projects },
    capabilities: [],
    connectors: [],
    externalAssets: { schemaVersion: 1, assets: [] },
  };
}

function recordingRunner(
  handler: (command: SafeProcessCommand) => { exitCode: number; stdout?: string },
  calls: SafeProcessCommand[],
): SafeProcessRunner {
  return async (command) => {
    calls.push(command);
    return handler(command);
  };
}

test("validate emits a parseable valid JSON report for the checked-in repository", async () => {
  const result = await runCli(["validate", "--json"], { cwd: process.cwd() });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, errors: [] });
});

test("validate emits every available configuration error in JSON", async () => {
  const config = repositoryConfig([
    { name: "unsafe", path: "../outside", repository: "http://unsafe.example/project.git" },
  ]);
  const result = await runCli(["validate", "--json"], {
    cwd: process.cwd(),
    dependencies: {
      validateCommand: { loadConfig: async () => config },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: false,
    errors: [
      "project unsafe has unsafe path ../outside",
      "project unsafe has unsafe repository",
    ],
  });
});

test("asset validation catches a missing skill entrypoint and linked support artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-asset-validation-"));

  try {
    for (const directory of ["roles", "workflows", "skills"]) {
      await cp(join(process.cwd(), directory), join(root, directory), { recursive: true });
    }
    const grillEntrypoint = join(root, "skills", "grill-me", "SKILL.md");
    await writeFile(
      grillEntrypoint,
      (await readFile(grillEntrypoint, "utf8")).replace(
        "references/question-bank.md",
        "references/missing-question-bank.md",
      ),
      "utf8",
    );
    await rm(join(root, "workflows", "test", "SKILL.md"));

    const errors = await validateRepositoryAssets(root);

    assert.ok(
      errors.includes("skills/grill-me/SKILL.md references a missing local support artifact"),
    );
    assert.ok(errors.includes("missing skill entrypoint workflows/test/SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate catches role profile references to missing checked-in assets", async () => {
  const config = repositoryConfig();
  config.roleProfiles = [
    {
      id: "dev",
      teamSkills: ["missing-skill"],
      externalSkills: [],
      workflows: ["missing-workflow"],
      capabilities: [],
    },
  ];

  const result = await runCli(["validate", "--json"], {
    cwd: process.cwd(),
    dependencies: { validateCommand: { loadConfig: async () => config } },
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: false,
    errors: [
      "role dev references missing team skill skills/missing-skill/SKILL.md",
      "role dev references missing workflow workflows/missing-workflow/SKILL.md",
    ],
  });
});

test("doctor distinguishes configured and missing connector variables without exposing values", async () => {
  const calls: SafeProcessCommand[] = [];
  const config = repositoryConfig();
  config.connectors = [
    {
      id: "jira",
      kind: "http",
      requiredEnv: ["JIRA_BASE_URL", "JIRA_API_TOKEN"],
      provides: [],
    },
    {
      id: "mysql-mcp",
      kind: "mcp-command",
      requiredEnv: ["MYSQL_MCP_COMMAND"],
      provides: [],
    },
  ];
  const runner = recordingRunner((command) => {
    if (command.program === "git") {
      return { exitCode: 0, stdout: "git version 2.45.0\n" };
    }
    if (command.program === "codex") {
      return { exitCode: 0, stdout: "codex 1.0.0\n" };
    }
    return { exitCode: 127 };
  }, calls);

  const result = await runCli(["doctor", "--json"], {
    cwd: process.cwd(),
    dependencies: {
      doctorCommand: {
        loadConfig: async () => config,
        env: {
          JIRA_BASE_URL: "https://jira.example.test",
          JIRA_API_TOKEN: "not-for-output",
        },
        nodeVersion: "v20.20.2",
        runner,
        planExternalAssets: async () => [],
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /not-for-output/u);
  const output = JSON.parse(result.stdout) as {
    node: { version: string };
    git: { state: string; version?: string };
    connectors: Array<{ id: string; state: string; missing: string[] }>;
    tools: Array<{ name: string; state: string }>;
  };
  assert.deepEqual(output.node, { state: "available", version: "v20.20.2" });
  assert.deepEqual(output.git, { state: "available", version: "git version 2.45.0" });
  assert.deepEqual(output.connectors, [
    { id: "jira", state: "configured", missing: [] },
    { id: "mysql-mcp", state: "not-configured", missing: ["MYSQL_MCP_COMMAND"] },
  ]);
  assert.deepEqual(output.tools, [
    { name: "codex", state: "available", version: "codex 1.0.0" },
    { name: "claude", state: "not-available" },
    { name: "opencode", state: "not-available" },
  ]);
  assert.deepEqual(
    calls.map((command) => command.program),
    ["git", "codex", "claude", "opencode"],
  );
});

test("status reports a missing project and a clean repository independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-status-"));
  const calls: SafeProcessCommand[] = [];
  const config = repositoryConfig([
    { name: "missing", path: "projects/missing" },
    { name: "clean", path: "projects/clean" },
  ]);
  await mkdir(join(root, "projects", "clean"), { recursive: true });

  try {
    const result = await runCli(["status", "--json"], {
      cwd: root,
      dependencies: {
        statusCommand: {
          loadConfig: async () => config,
          runner: recordingRunner((command) => {
            if (command.args.includes("rev-parse")) {
              return { exitCode: 0, stdout: "true\n" };
            }
            if (command.args.includes("branch")) {
              return { exitCode: 0, stdout: "main\n" };
            }
            if (command.args.includes("status")) {
              return { exitCode: 0, stdout: "" };
            }
            return { exitCode: 1 };
          }, calls),
        },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      valid: true,
      errors: [],
      projects: [
        { name: "missing", path: "projects/missing", state: "missing" },
        { name: "clean", path: "projects/clean", state: "clean", branch: "main" },
      ],
    });
    assert.equal(calls.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const command of ["validate", "doctor", "status", "init"]) {
  test(`${command} rejects an unknown flag with exit code 2`, async () => {
    const result = await runCli([command, "--unknown"]);

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unknown flag/u);
  });

  test(`${command} keeps JSON parseable for an invalid flag request`, async () => {
    const result = await runCli([command, "--json", "--unknown"]);

    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr, "");
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors[0] ?? "",
      /unknown flag/u,
    );
  });
}
