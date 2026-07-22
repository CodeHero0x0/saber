import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import {
  runConvenienceCommand,
  type ConvenienceCommandDependencies,
} from "../src/commands/convenience.js";
import { SaberError } from "../src/lib/errors.js";
import type { MaterializeResult } from "../src/lib/materialize.js";
import type { RepositoryConfig, RoleName, ToolName } from "../src/lib/models.js";
import type { WorkitemStatusReport } from "../src/lib/workitems.js";

const coreCommands = [
  "saber",
  "saber-intake",
  "saber-focus",
  "saber-status",
  "saber-refine",
  "saber-help",
];

function config(teamTool: ToolName = "codex", localTool?: ToolName): RepositoryConfig {
  return {
    saber: {
      schemaVersion: 1,
      name: "Convenience fixture",
      safety: { externalWrites: "preview-and-confirm", forbiddenRiskLevels: ["L3"] },
    },
    workspace: {
      schemaVersion: 1,
      tools: { default: teamTool, supported: ["codex", "claude", "opencode"], defaultCapabilities: [] },
      projects: [],
    },
    capabilities: [],
    connectors: [],
    externalAssets: { schemaVersion: 1, assets: [] },
    roleProfiles: ["ba", "dev", "qa"].map((id) => ({
      id: id as RoleName,
      teamSkills: [],
      externalSkills: [],
      workflows: [],
      capabilities: [],
    })),
    ...(localTool === undefined
      ? {}
      : {
          local: {
            schemaVersion: 1 as const,
            defaults: { tool: localTool },
            projects: {},
            extensions: { skills: [], prompts: [], capabilities: [] },
          },
        }),
  };
}

function materialized(role: RoleName, tool: ToolName, project?: string): MaterializeResult {
  return {
    schemaVersion: 2,
    managedBy: "saber",
    role,
    tool,
    project: project ?? null,
    capabilities: [],
    coreCommands,
    teamSkills: [`${role}-recommended`],
    prompts: [],
    externalSkills: [`${role}-external`],
    workflows: [],
    projections: [],
    manifestPath: `.saber/runtime/materialize/${tool}/root.json`,
    discoveryRoot: tool === "codex" ? ".agents/skills" : tool === "claude" ? ".claude/skills" : ".opencode/skills",
  };
}

test("CLI help lists Daily commands before Advanced commands", async () => {
  const result = await runCli([]);
  const daily = result.stdout.indexOf("Daily commands:");
  const advanced = result.stdout.indexOf("Advanced commands:");

  assert.ok(daily >= 0);
  assert.ok(advanced > daily);
  for (const command of ["setup", "use", "demo", "open", "loop", "next", "pause", "resume"]) {
    assert.match(result.stdout.slice(daily, advanced), new RegExp(`saber ${command}`));
  }
});

test("CLI routes every daily command through convenience dependencies", async () => {
  const calls: Array<{ command: string; argv: readonly string[] }> = [];
  for (const command of ["setup", "use", "demo", "open", "loop", "next", "pause", "resume"]) {
    const result = await runCli([command, "argument", "--json"], {
      cwd: "/fixture",
      dependencies: {
        convenienceCommand: {
          runCommand: async (routedCommand, argv) => {
            calls.push({ command: routedCommand, argv });
            return { exitCode: 7, stdout: "routed", stderr: "" };
          },
        },
      },
    });
    assert.deepEqual(result, { exitCode: 7, stdout: "routed", stderr: "" });
  }

  assert.deepEqual(calls, ["setup", "use", "demo", "open", "loop", "next", "pause", "resume"].map(
    (command) => ({ command, argv: ["argument", "--json"] }),
  ));
});

test("use supports all nine role and tool combinations", async () => {
  for (const role of ["ba", "dev", "qa"] as const) {
    for (const tool of ["codex", "claude", "opencode"] as const) {
      const calls: Array<{ role: RoleName; tool?: ToolName; project?: string }> = [];
      const result = await runConvenienceCommand("use", [role, "--tool", tool, "--json"], {
        cwd: "/fixture",
        dependencies: {
          loadConfig: async () => config(),
          materialize: async (_root, _config, options) => {
            calls.push(options);
            return materialized(role, tool);
          },
        },
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(calls, [{ role, tool }]);
      const output = JSON.parse(result.stdout) as {
        tool: ToolName;
        defaultRole: RoleName;
        installedCommands: string[];
        recommendedSkills: string[];
        start: string;
      };
      assert.equal(output.tool, tool);
      assert.equal(output.defaultRole, role);
      assert.deepEqual(output.installedCommands, coreCommands);
      assert.deepEqual(output.recommendedSkills, [`${role}-recommended`, `${role}-external`]);
      assert.match(output.start, new RegExp(`^${tool} \\.$`));
      assert.deepEqual(Object.keys(output), [
        "tool",
        "defaultRole",
        "installedCommands",
        "recommendedSkills",
        "start",
      ]);
    }
  }
});

test("use renders only the administrator materialize report and no daily CLI suggestions", async () => {
  const result = await runConvenienceCommand("use", ["dev", "--tool", "claude"], {
    cwd: "/fixture",
    dependencies: {
      loadConfig: async () => config(),
      materialize: async () => materialized("dev", "claude"),
    },
  });

  assert.match(result.stdout, /工具.*Claude Code/u);
  assert.match(result.stdout, /默认角色.*DEV/u);
  assert.match(result.stdout, /已安装命令.*saber-intake/u);
  assert.match(result.stdout, /推荐技能.*dev-recommended.*dev-external/u);
  assert.match(result.stdout, /启动方式.*claude \./u);
  assert.doesNotMatch(result.stdout, /saber (?:open|next|loop)/u);
});

test("use resolves explicit, personal, then team tool precedence and forwards a strict project", async () => {
  const selected: Array<{ tool?: ToolName; project?: string }> = [];
  const dependencies: ConvenienceCommandDependencies = {
    loadConfig: async () => config("codex", "claude"),
    materialize: async (_root, _config, options) => {
      selected.push(options);
      return materialized(options.role, options.tool ?? "codex", options.project);
    },
  };

  await runConvenienceCommand("use", ["dev"], { cwd: "/fixture", dependencies });
  await runConvenienceCommand("use", ["dev", "--tool", "opencode", "--project", "backend"], { cwd: "/fixture", dependencies });
  await runConvenienceCommand("use", ["dev"], {
    cwd: "/fixture",
    dependencies: { ...dependencies, loadConfig: async () => config("codex") },
  });

  assert.deepEqual(selected, [
    { role: "dev", tool: "claude" },
    { role: "dev", tool: "opencode", project: "backend" },
    { role: "dev", tool: "codex" },
  ]);
  const invalid = await runConvenienceCommand("use", ["dev", "--project"], { cwd: "/fixture", dependencies });
  assert.equal(invalid.exitCode, 2);
});

const status: WorkitemStatusReport = {
  key: "ABC-1",
  source: {
    kind: "jira",
    title: "Checkout fails after payment",
    origin: "https://jira.example.test/browse/ABC-1",
    snapshot: "intake.md",
    fingerprint: "abc",
    capturedAt: "2026-07-22T00:00:00.000Z",
    references: [],
  },
  workflow: {
    state: "qa-verify",
    role: "qa",
    iteration: 2,
    pausedFrom: null,
    pauseReason: null,
    updatedAt: "2026-07-22T00:00:00.000Z",
    history: [{ from: "dev-build", to: "qa-verify", result: "ready", role: "dev", recordedAt: "2026-07-22T00:00:00.000Z", summary: "Ready for QA." }],
  },
  repositories: [{ name: "backend", path: "projects/backend", branch: "feature/ABC-1", commit: "a1b2c3d4", mergeRequest: "!7", ci: "passed" }],
  artifacts: [{ path: "requirements.md", state: "present" }, { path: "tests.md", state: "missing" }],
  handoffCount: 1,
  suggestion: "saber next ABC-1 --result pass|fail|blocked",
};

test("open and loop render status, route and history without filesystem access", async () => {
  const dependencies: ConvenienceCommandDependencies = { getStatus: async () => status };
  const opened = await runConvenienceCommand("open", ["ABC-1"], { cwd: "/fixture", dependencies });
  const loop = await runConvenienceCommand("loop", ["ABC-1"], { cwd: "/fixture", dependencies });

  assert.match(opened.stdout, /State: qa-verify/u);
  assert.match(opened.stdout, /Source: jira - Checkout fails after payment/u);
  assert.match(opened.stdout, /Origin: https:\/\/jira\.example\.test\/browse\/ABC-1/u);
  assert.match(opened.stdout, /Snapshot: intake\.md/u);
  assert.match(opened.stdout, /Missing evidence: tests\.md/u);
  assert.match(opened.stdout, /Fingerprint: abc/u);
  assert.match(opened.stdout, /requirements\.md=present, tests\.md=missing/u);
  assert.match(opened.stdout, /Handoffs: 1/u);
  assert.match(opened.stdout, /backend\[branch=feature\/ABC-1,commit=a1b2c3d4,mr=!7,ci=passed\]/u);
  assert.match(loop.stdout, /qa-verify --fail--> dev-fix --ready--> qa-verify/u);
  assert.match(loop.stdout, /Current: \* qa-verify/u);
  assert.match(loop.stdout, /dev-build -> qa-verify: ready \(dev\)/u);
  assert.match(loop.stdout, /Ready for QA\./u);
});

test("mutation commands preserve usage, paused, and unexpected failure exit codes", async () => {
  const usage = await runConvenienceCommand("next", ["ABC-1"], { cwd: "/fixture" });
  assert.equal(usage.exitCode, 2);

  const advanced = await runConvenienceCommand("next", ["ABC-1", "--result", "ready"], {
    cwd: "/fixture",
    dependencies: {
      advance: async () => ({ key: "ABC-1", from: "dev-build", to: "qa-verify", result: "ready", role: "dev", iteration: 1 }),
    },
  });
  assert.equal(advanced.exitCode, 0);

  const paused = await runConvenienceCommand("next", ["ABC-1", "--result", "blocked"], {
    cwd: "/fixture",
    dependencies: {
      advance: async () => ({ key: "ABC-1", from: "dev-build", to: "paused", result: "blocked", role: "dev", iteration: 1 }),
    },
  });
  assert.equal(paused.exitCode, 3);

  const pausedManually = await runConvenienceCommand("pause", ["ABC-1", "--reason", "wait"], {
    cwd: "/fixture",
    dependencies: {
      pause: async () => ({ key: "ABC-1", from: "qa-verify", to: "paused", result: "paused", role: "qa", iteration: 1 }),
    },
  });
  assert.equal(pausedManually.exitCode, 3);

  const resumed = await runConvenienceCommand("resume", ["ABC-1"], {
    cwd: "/fixture",
    dependencies: {
      resume: async () => ({ key: "ABC-1", from: "paused", to: "qa-verify", result: "resume", role: "qa", iteration: 1 }),
    },
  });
  assert.equal(resumed.exitCode, 0);

  const rejected = await runConvenienceCommand("resume", ["ABC-1"], {
    cwd: "/fixture",
    dependencies: { resume: async () => { throw new SaberError("cannot resume", 2); } },
  });
  assert.deepEqual(rejected, { exitCode: 2, stdout: "", stderr: "cannot resume\n" });

  const failed = await runConvenienceCommand("pause", ["ABC-1", "--reason", "wait"], {
    cwd: "/fixture",
    dependencies: { pause: async () => { throw new Error("private detail"); } },
  });
  assert.deepEqual(failed, { exitCode: 1, stdout: "", stderr: "pause command failed\n" });
});

test("setup never overwrites local config and previews external updates by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-setup-kept-"));
  const externalArgs: string[][] = [];
  try {
    await writeFile(join(root, "saber.local.yaml"), "personal: true\n", "utf8");
    const result = await runConvenienceCommand("setup", ["--json"], {
      cwd: root,
      dependencies: {
        loadConfig: async () => config(),
        doctor: async () => ({ marker: "doctor" }),
        externalUpdate: async (argv) => {
          externalArgs.push([...argv]);
          return { exitCode: 0, stdout: '{"mode":"preview"}\n', stderr: "" };
        },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(join(root, "saber.local.yaml"), "utf8"), "personal: true\n");
    assert.equal(JSON.parse(result.stdout).localCreated, false);
    assert.deepEqual(externalArgs, [["update", "--json"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup creates local config only for ENOENT and stops on other filesystem errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-setup-not-directory-"));
  const notDirectory = join(root, "not-a-directory");
  let sideEffects = 0;
  try {
    await writeFile(notDirectory, "file\n", "utf8");
    const result = await runConvenienceCommand("setup", [], {
      cwd: notDirectory,
      dependencies: {
        loadConfig: async () => config(),
        doctor: async () => { sideEffects += 1; return { marker: "doctor" }; },
        externalUpdate: async () => {
          sideEffects += 1;
          return { exitCode: 0, stdout: "{}\n", stderr: "" };
        },
      },
    });

    assert.deepEqual(result, { exitCode: 1, stdout: "", stderr: "setup command failed\n" });
    assert.equal(sideEffects, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup creates a missing local config exclusively and keeps apply plus confirm paired", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-setup-created-"));
  const externalArgs: string[][] = [];
  try {
    await writeFile(join(root, "saber.local.example.yaml"), "schemaVersion: 1\n", "utf8");
    const result = await runConvenienceCommand("setup", ["--apply", "--confirm", "--json"], {
      cwd: root,
      dependencies: {
        loadConfig: async () => config(),
        doctor: async () => ({ marker: "doctor" }),
        externalUpdate: async (argv) => {
          externalArgs.push([...argv]);
          return { exitCode: 0, stdout: '{"mode":"apply"}\n', stderr: "" };
        },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(join(root, "saber.local.yaml"), "utf8"), "schemaVersion: 1\n");
    assert.equal(JSON.parse(result.stdout).localCreated, true);
    assert.deepEqual(externalArgs, [["update", "--apply", "--confirm", "--json"]]);

    await assert.rejects(
      () => copyFile(join(root, "saber.local.example.yaml"), join(root, "saber.local.yaml"), 1),
      /EEXIST/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup rejects unpaired apply or confirm without invoking external updates", async () => {
  let calls = 0;
  for (const argument of ["--apply", "--confirm"]) {
    const result = await runConvenienceCommand("setup", [argument], {
      cwd: "/fixture",
      dependencies: { externalUpdate: async () => { calls += 1; return { exitCode: 0, stdout: "{}\n", stderr: "" }; } },
    });
    assert.equal(result.exitCode, 2);
  }
  assert.equal(calls, 0);
});
