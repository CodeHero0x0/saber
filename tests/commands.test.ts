import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { validateRepositoryAssets } from "../src/commands/validate.js";
import { materialize } from "../src/lib/materialize.js";
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
    roleProfiles: [],
    mcp: { servers: [] },
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

test("doctor reports MCP prerequisites and risk routes without executing configured commands or exposing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-doctor-mcp-"));
  const calls: SafeProcessCommand[] = [];
  const config = repositoryConfig();
  config.capabilities = [
    { id: "idea.read", risk: "L0", kind: "read" },
    { id: "idea.write", risk: "L2", kind: "action" },
  ];
  config.mcp.servers = [
    {
      id: "idea",
      transport: "stdio",
      command: "tools/idea-server",
      args: [],
      cwd: ".",
      env: { TOKEN: "IDEA_SECRET", OPTIONAL: "MISSING_IDEA_SECRET" },
      tools: [
        { name: "inspect", capability: "idea.read" },
        { name: "update", capability: "idea.write" },
      ],
    },
    {
      id: "path-override",
      transport: "stdio",
      command: "node",
      args: [],
      cwd: ".",
      env: { PATH: "MCP_PATH" },
      tools: [],
    },
    {
      id: "symlink-command",
      transport: "stdio",
      command: "linked-tool",
      args: [],
      cwd: ".",
      env: { PATH: "LINK_PATH" },
      tools: [],
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

  try {
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "tools", "idea-server"), "fixture\n", "utf8");
    await chmod(join(root, "tools", "idea-server"), 0o700);
    await mkdir(join(root, "empty-path"));
    await symlink(join(root, "tools", "idea-server"), join(root, "empty-path", "linked-tool"));
    await writeFile(
      join(root, ".env"),
      `IDEA_SECRET=not-for-output\nMCP_PATH=${join(root, "empty-path")}\nLINK_PATH=${join(root, "empty-path")}${delimiter}\n`,
      "utf8",
    );

    const result = await runCli(["doctor", "--json"], {
      cwd: root,
      dependencies: {
        doctorCommand: {
          loadConfig: async () => config,
          env: {},
          nodeVersion: "v20.20.2",
          runner,
          planExternalAssets: async () => [],
        },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /not-for-output/u);
    assert.doesNotMatch(result.stdout, /connected|configured/u);
    const output = JSON.parse(result.stdout) as {
      mcp: {
        servers: Array<{
          id: string;
          state: string;
          environment: { state: string; missing: string[] };
          command?: { state: string };
          cwd?: { state: string };
          tools: Array<{ name: string; risk: string; route: string }>;
        }>;
        clients: Array<{ name: string; trust: string; restart: string }>;
        policy: { l2: string; l3: string };
      };
    };
    assert.deepEqual(output.mcp.servers, [
      {
        id: "idea",
        transport: "stdio",
        state: "invalid",
        environment: { state: "missing", missing: ["MISSING_IDEA_SECRET"] },
        command: { state: "available" },
        cwd: { state: "available" },
        tools: [
          { name: "inspect", capability: "idea.read", risk: "L0", route: "native" },
          { name: "update", capability: "idea.write", risk: "L2", route: "action-gateway" },
        ],
      },
      {
        id: "path-override",
        transport: "stdio",
        state: "invalid",
        environment: { state: "available", missing: [] },
        command: { state: "missing" },
        cwd: { state: "available" },
        tools: [],
      },
      {
        id: "symlink-command",
        transport: "stdio",
        state: "valid",
        environment: { state: "available", missing: [] },
        command: { state: "available" },
        cwd: { state: "available" },
        tools: [],
      },
    ]);
    assert.deepEqual(output.mcp.clients, [
      { name: "codex", trust: "unknown", restart: "unknown" },
      { name: "claude", trust: "unknown", restart: "unknown" },
      { name: "opencode", trust: "unknown", restart: "unknown" },
    ]);
    assert.deepEqual(output.mcp.policy, {
      oauth: "unsupported",
      l2: "action-gateway",
      l3: "forbidden",
    });
    assert.deepEqual(calls.map((command) => command.program), ["git", "codex", "claude", "opencode"]);

    await mkdir(join(root, ".saber/runtime"), { recursive: true });
    await symlink(join(root, "tools"), join(root, ".saber/runtime/materialize"));
    const unsafeRuntime = JSON.parse((await runCli(["doctor", "--json"], {
      cwd: root,
      dependencies: {
        doctorCommand: {
          loadConfig: async () => config,
          env: {},
          runner,
          planExternalAssets: async () => [],
        },
      },
    })).stdout) as { mcp: { runtime: { targets: Array<{ state: string; issues: string[] }> } } };
    assert.ok(unsafeRuntime.mcp.runtime.targets.every(({ state }) => state === "invalid"));
    assert.ok(unsafeRuntime.mcp.runtime.targets.every(({ issues }) =>
      issues.includes("manifest-directory-invalid")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor detects materialized MCP drift and unresolved transactions without repairing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-doctor-runtime-"));
  const config = repositoryConfig();
  config.workspace.tools.supported = ["codex", "claude", "opencode"];
  config.capabilities = [{ id: "mysql.read", risk: "L0", kind: "read" }];
  config.roleProfiles = [{
    id: "dev",
    teamSkills: [],
    externalSkills: [],
    workflows: [],
    capabilities: ["mysql.read"],
  }];
  config.mcp.servers = [{
    id: "mysql",
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    tools: [{ name: "query", capability: "mysql.read" }],
  }];

  try {
    await mkdir(join(root, ".git/info"), { recursive: true });
    for (const name of ["saber", "saber-intake", "saber-focus", "saber-status", "saber-refine", "saber-help"]) {
      await cp(join(process.cwd(), "skills", name), join(root, "skills", name), { recursive: true });
    }
    const materialized = await materialize(root, config, { role: "dev", tool: "claude" });
    const nativePath = join(root, ".mcp.json");
    const nativeConfig = JSON.parse(await readFile(nativePath, "utf8")) as Record<string, unknown>;
    await writeFile(nativePath, `${JSON.stringify({ ...nativeConfig, userSetting: true }, null, 2)}\n`, "utf8");
    const dependencies = {
      loadConfig: async () => config,
      env: {},
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      planExternalAssets: async () => [],
    };

    const valid = JSON.parse((await runCli(["doctor", "--json"], {
      cwd: root,
      dependencies: { doctorCommand: dependencies },
    })).stdout) as {
      mcp: { runtime: { targets: Array<{ state: string; issues: string[] }> }; clients: Array<{ name: string; trust: string; restart: string }> };
    };
    assert.deepEqual(valid.mcp.runtime.targets, [{
      tool: "claude",
      target: "root",
      project: null,
      state: "valid",
      issues: [],
    }]);
    assert.deepEqual(valid.mcp.clients.find(({ name }) => name === "claude"), {
      name: "claude",
      trust: "pending",
      restart: "pending",
    });

    await writeFile(join(root, ".saber/runtime/mcp/claude/root/mysql.json"), "{}\n", "utf8");
    await writeFile(join(root, ".saber/runtime/mcp/claude/root/_active.json"), "{}\n", "utf8");
    await writeFile(nativePath, "{}\n", "utf8");
    await mkdir(join(root, ".saber/runtime/transactions"), { recursive: true });
    await writeFile(join(root, ".saber/runtime/transactions/uninstall.json"), "pending\n", "utf8");
    await writeFile(join(root, ".saber/runtime/materialize/codex"), "unsafe\n", "utf8");

    const driftedResult = await runCli(["doctor", "--json"], {
      cwd: root,
      dependencies: { doctorCommand: dependencies },
    });
    const drifted = JSON.parse(driftedResult.stdout) as {
      mcp: {
        runtime: {
          targets: Array<{ state: string; issues: string[] }>;
          transactions: { state: string; entries: string[] };
        };
      };
    };
    assert.equal(driftedResult.exitCode, 0);
    const claudeTarget = drifted.mcp.runtime.targets.find(({ tool }) => tool === "claude");
    assert.equal(claudeTarget?.state, "invalid");
    assert.deepEqual(claudeTarget?.issues, [
      "active-index-drift",
      "descriptor-drift:mysql",
      "native-config-drift",
    ]);
    assert.deepEqual(drifted.mcp.runtime.targets.find(({ tool }) => tool === "codex"), {
      tool: "codex",
      target: "unknown",
      project: null,
      state: "invalid",
      issues: ["manifest-directory-invalid"],
    });
    assert.deepEqual(drifted.mcp.runtime.transactions, {
      state: "unresolved",
      entries: ["uninstall.json"],
    });
    assert.equal(materialized.manifestPath, ".saber/runtime/materialize/claude/root.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
