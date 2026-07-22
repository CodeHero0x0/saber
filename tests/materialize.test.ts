import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { materialize } from "../src/lib/materialize.js";
import type { RepositoryConfig, RoleProfile, ToolName } from "../src/lib/models.js";
import { toolConfigAdapters } from "../src/lib/tool-configs/index.js";

const coreCommands = [
  "saber",
  "saber-intake",
  "saber-focus",
  "saber-status",
  "saber-refine",
  "saber-help",
] as const;

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "saber-materialize-"));
}

async function skill(root: string, path: string, name: string): Promise<void> {
  await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, path, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test package.\n---\n\n# ${name}\n`,
    "utf8",
  );
}

const profiles: RoleProfile[] = [
  {
    id: "ba",
    teamSkills: ["grill-me"],
    externalSkills: ["openspec/openspec-explore"],
    workflows: ["requirements"],
    capabilities: ["jira.read"],
  },
  {
    id: "dev",
    teamSkills: ["superpowers"],
    externalSkills: ["superpowers/writing-plans"],
    workflows: ["develop"],
    capabilities: ["jira.read", "gitlab.mr.read"],
  },
  {
    id: "qa",
    teamSkills: ["superpowers"],
    externalSkills: [],
    workflows: ["test"],
    capabilities: ["gitlab.mr.read"],
  },
];

function config(): RepositoryConfig {
  return {
    saber: {
      schemaVersion: 1,
      name: "Saber materialize fixture",
      safety: { externalWrites: "preview-and-confirm", forbiddenRiskLevels: ["L3"] },
    },
    workspace: {
      schemaVersion: 1,
      tools: {
        default: "codex",
        supported: ["codex", "claude", "opencode"],
        defaultCapabilities: ["jira.read"],
      },
      projects: [
        { name: "backend", path: "projects/backend", capabilities: ["mysql.read"] },
      ],
    },
    capabilities: [
      { id: "jira.read", risk: "L0", kind: "read", connector: "jira" },
      { id: "gitlab.mr.read", risk: "L0", kind: "read", connector: "gitlab" },
      { id: "mysql.read", risk: "L0", kind: "read" },
    ],
    connectors: [
      { id: "jira", kind: "http", requiredEnv: ["JIRA_BASE_URL", "JIRA_ACCOUNT_ID", "JIRA_API_TOKEN"], provides: ["jira.read"] },
      { id: "gitlab", kind: "http", requiredEnv: ["GITLAB_BASE_URL", "GITLAB_ACCOUNT_ID", "GITLAB_API_TOKEN"], provides: ["gitlab.mr.read"] },
    ],
    mcp: {
      servers: [{
        id: "mysql",
        transport: "stdio",
        command: "node",
        args: ["tools/mysql-mcp.js"],
        env: {},
        tools: [{ name: "query", capability: "mysql.read" }],
      }],
    },
    externalAssets: {
      schemaVersion: 1,
      assets: [
        {
          id: "openspec",
          category: "skill-collection",
          description: "OpenSpec fixture.",
          kind: "git",
          source: "https://example.test/openspec.git",
          packages: [{ id: "openspec-explore", sourcePath: "skills/openspec-explore" }],
        },
        {
          id: "superpowers",
          category: "skill-collection",
          description: "Superpowers fixture.",
          kind: "git",
          source: "https://example.test/superpowers.git",
          packages: [{ id: "writing-plans", sourcePath: "skills/writing-plans" }],
        },
      ],
    },
    roleProfiles: profiles,
  };
}

async function fixture(root: string): Promise<void> {
  for (const [path, name] of [
    ...coreCommands.map((name) => [`skills/${name}`, name]),
    ["skills/grill-me", "grill-me"],
    ["skills/superpowers", "superpowers"],
    ["workflows/requirements", "requirements"],
    ["workflows/develop", "develop"],
    ["workflows/test", "test"],
    [".saber/external/saber-v1/skills/openspec/openspec-explore", "openspec-explore"],
    [".saber/external/saber-v1/skills/superpowers/writing-plans", "writing-plans"],
  ]) {
    await skill(root, path, name);
  }
  await writeFile(
    join(root, ".saber/external/saber-v1/manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      managedBy: "saber",
      packages: [
        {
          id: "openspec/openspec-explore",
          category: "skill-collection",
          materializedPath: ".saber/external/saber-v1/skills/openspec/openspec-explore",
          revision: "abc123",
        },
        {
          id: "superpowers/writing-plans",
          category: "skill-collection",
          materializedPath: ".saber/external/saber-v1/skills/superpowers/writing-plans",
          revision: "def456",
        },
      ],
    })}\n`,
    "utf8",
  );
}

test("materialize projects only the selected Codex role assets", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    const result = await materialize(root, config(), { role: "dev", tool: "codex" });
    assert.equal(result.tool, "codex");
    assert.equal(result.role, "dev");
    assert.deepEqual(result.coreCommands, coreCommands);
    assert.deepEqual(result.externalSkills, ["superpowers/writing-plans"]);
    assert.ok(result.projections.every((projection) => projection.linkPath.startsWith(".agents/skills/saber--")));
    assert.equal(result.projections.length, 10);
    for (const projection of result.projections) {
      assert.equal((await lstat(join(root, projection.linkPath))).isSymbolicLink(), true);
      assert.ok((await readlink(join(root, projection.linkPath))).length > 0);
    }
    const manifest = JSON.parse(await readFile(join(root, result.manifestPath), "utf8")) as {
      schemaVersion: number;
      coreCommands: string[];
      capabilities: string[];
    };
    assert.equal(manifest.schemaVersion, 3);
    assert.deepEqual(manifest.coreCommands, coreCommands);
    assert.deepEqual(manifest.capabilities, ["jira.read", "gitlab.mr.read"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialize makes local skill and capability extensions effective", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await skill(root, "skills/local-review", "local-review");
    const configured = config();
    configured.local = {
      schemaVersion: 2,
      defaults: {},
      projects: {},
      extensions: { skills: ["saber", "local-review"], prompts: ["concise-review"], capabilities: ["mysql.read"], mcpServers: [] },
      mcp: { servers: [] },
    };
    await skill(root, "prompts/concise-review", "concise-review");

    const result = await materialize(root, configured, { role: "qa", tool: "codex" });

    assert.deepEqual(result.teamSkills, ["superpowers", "local-review"]);
    assert.deepEqual(result.prompts, ["concise-review"]);
    assert.ok(result.projections.some((projection) => projection.name === "saber--personal-prompt--concise-review"));
    assert.equal(
      result.projections.filter((projection) => projection.name === "saber--core-command--saber")
        .length,
      1,
    );
    assert.deepEqual(result.capabilities, ["gitlab.mr.read", "mysql.read", "jira.read"]);
    const localProjection = result.projections.find(
      (projection) => projection.name === "saber--team-skill--local-review",
    );
    assert.ok(localProjection);
    assert.equal((await lstat(join(root, localProjection.linkPath))).isSymbolicLink(), true);
    const context = await readFile(
      join(root, ".saber/runtime/materialize/codex/root/context/SKILL.md"),
      "utf8",
    );
    assert.match(context, /Capabilities: gitlab\.mr\.read, mysql\.read, jira\.read/u);
    assert.match(context, /Team skills: superpowers, local-review/u);
    assert.match(context, /CLI.*内部接口/u);
    assert.match(context, /默认角色.*路由上下文.*不是授权/u);
    assert.match(context, /MCP.*批准.*配置/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialize rejects a package whose frontmatter name can shadow a core command", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await skill(root, "skills/local-review", "saber");
    const configured = config();
    configured.local = {
      schemaVersion: 2,
      defaults: {},
      projects: {},
      extensions: { skills: ["local-review"], prompts: [], capabilities: [], mcpServers: [] },
      mcp: { servers: [] },
    };

    await assert.rejects(
      () => materialize(root, configured, { role: "qa", tool: "codex" }),
      /team skill local-review package is missing or invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("role switch removes only previous Saber links and preserves personal skills", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await skill(root, ".agents/skills/personal", "personal");
    await materialize(root, config(), { role: "dev", tool: "codex" });
    const switched = await materialize(root, config(), { role: "qa", tool: "codex" });
    assert.equal((await lstat(join(root, ".agents/skills/personal"))).isDirectory(), true);
    assert.ok(switched.projections.some((projection) => projection.name === "saber--context--qa"));
    await assert.rejects(() => lstat(join(root, ".agents/skills/saber--context--dev")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tampered runtime manifest cannot unlink outside the tool discovery directory", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink("../skills/grill-me", join(root, ".agents/personal-link"), "dir");
    const first = await materialize(root, config(), { role: "dev", tool: "codex" });
    const manifestPath = join(root, first.manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      projections: Array<{ linkPath: string }>;
    };
    manifest.projections[0]!.linkPath = ".agents/personal-link";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    await assert.rejects(
      () => materialize(root, config(), { role: "dev", tool: "codex" }),
      /unsafe projection/u,
    );
    assert.equal((await lstat(join(root, ".agents/personal-link"))).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an external manifest cannot redirect a configured package to another skill directory", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    const manifestPath = join(root, ".saber/external/saber-v1/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      packages: Array<{ id: string; materializedPath: string }>;
    };
    const writingPlans = manifest.packages.find(
      (entry) => entry.id === "superpowers/writing-plans",
    );
    assert.ok(writingPlans);
    writingPlans.materializedPath = "skills/grill-me";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    await assert.rejects(
      () => materialize(root, config(), { role: "dev", tool: "codex" }),
      /external skill.*missing|external manifest/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a role switch collision preserves the previous complete projection set", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await materialize(root, config(), { role: "dev", tool: "codex" });
    await skill(root, ".agents/skills/saber--workflow--test", "personal-collision");

    await assert.rejects(
      () => materialize(root, config(), { role: "qa", tool: "codex" }),
      /already exists/iu,
    );
    assert.equal(
      (await lstat(join(root, ".agents/skills/saber--context--dev"))).isSymbolicLink(),
      true,
    );
    await assert.rejects(
      () => lstat(join(root, ".agents/skills/saber--context--qa")),
      /ENOENT/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all roles and supported tools always project the six core commands", async () => {
  const roots: Record<ToolName, string> = {
    codex: ".agents/skills",
    claude: ".claude/skills",
    opencode: ".opencode/skills",
  };
  for (const tool of Object.keys(roots) as ToolName[]) {
    for (const role of ["ba", "dev", "qa"] as const) {
      const root = await temporaryRoot();
      try {
        await fixture(root);
        const result = await materialize(root, config(), { role, tool });
        assert.equal(result.discoveryRoot, roots[tool]);
        assert.deepEqual(result.coreCommands, coreCommands);
        assert.deepEqual(
          result.projections
            .filter((projection) => projection.kind === "core-command")
            .map((projection) => projection.name),
          coreCommands.map((id) => `saber--core-command--${id}`),
        );
        assert.deepEqual(result.teamSkills, profiles.find((profile) => profile.id === role)?.teamSkills);
        assert.deepEqual(result.workflows, profiles.find((profile) => profile.id === role)?.workflows);
        assert.ok(result.projections.every((projection) => projection.linkPath.startsWith(roots[tool])));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test("materialize rejects the obsolete runtime manifest schema instead of branching", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    const manifestPath = join(root, ".saber/runtime/materialize/codex/root.json");
    await mkdir(join(root, ".saber/runtime/materialize/codex"), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        managedBy: "saber",
        tool: "codex",
        role: "dev",
        project: null,
        capabilities: [],
        teamSkills: [],
        externalSkills: [],
        workflows: [],
        projections: [],
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      () => materialize(root, config(), { role: "dev", tool: "codex" }),
      /runtime manifest is not managed by Saber/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project materialize stays local to the nested repository and updates local exclude", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await mkdir(join(root, "projects/backend/.git/info"), { recursive: true });
    await writeFile(join(root, "projects/backend/.git/info/exclude"), "# local\n", "utf8");
    const result = await materialize(root, config(), {
      role: "dev",
      tool: "claude",
      project: "backend",
      capabilities: ["mysql.read"],
    });
    assert.equal(result.discoveryRoot, "projects/backend/.claude/skills");
    assert.deepEqual(result.capabilities, ["mysql.read"]);
    assert.deepEqual(result.mcpServers, ["mysql"]);
    const native = JSON.parse(
      await readFile(join(root, "projects/backend/.mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { args: string[]; cwd: string }> };
    assert.deepEqual(Object.keys(native.mcpServers), ["saber--mysql"]);
    assert.match(native.mcpServers["saber--mysql"]!.args.at(-1)!, /mcp\/claude\/backend\/mysql\.json$/u);
    assert.equal(native.mcpServers["saber--mysql"]!.cwd, root);
    const descriptor = JSON.parse(
      await readFile(join(root, ".saber/runtime/mcp/claude/backend/mysql.json"), "utf8"),
    ) as { server: { id: string }; descriptorFingerprint: string };
    assert.equal(descriptor.server.id, "mysql");
    assert.match(descriptor.descriptorFingerprint, /^sha256:[a-f0-9]{64}$/u);
    const manifest = JSON.parse(await readFile(join(root, result.manifestPath), "utf8")) as {
      schemaVersion: number;
      mcpServers: string[];
      mcpEntries: Array<{ id: string; digest: string }>;
      descriptors: Array<{ id: string; digest: string }>;
      sourceFingerprints: { team: string; local: string | null; external: string | null };
    };
    assert.equal(manifest.schemaVersion, 3);
    assert.deepEqual(manifest.mcpServers, ["mysql"]);
    assert.equal(manifest.mcpEntries[0]!.id, "saber--mysql");
    assert.match(manifest.mcpEntries[0]!.digest, /^[a-f0-9]{64}$/u);
    assert.equal(manifest.descriptors[0]!.id, "mysql");
    assert.match(manifest.descriptors[0]!.digest, /^[a-f0-9]{64}$/u);
    assert.match(manifest.sourceFingerprints.team, /^sha256:[a-f0-9]{64}$/u);
    assert.match(
      await readFile(join(root, "projects/backend/.git/info/exclude"), "utf8"),
      /\.claude\/skills\/saber--\*/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a native configuration replacement failure rolls back projections, MCP runtime, and manifest", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await mkdir(join(root, "projects/backend/.git/info"), { recursive: true });
    await mkdir(join(root, "projects/backend/.claude"), { recursive: true });
    await mkdir(join(root, ".saber/runtime/mcp"), { recursive: true });
    await writeFile(join(root, ".saber/runtime/mcp/claude"), "blocks runtime creation\n", "utf8");

    await assert.rejects(
      () => materialize(root, config(), {
        role: "dev",
        tool: "claude",
        project: "backend",
        capabilities: ["mysql.read"],
      }),
    );

    await assert.rejects(() => lstat(join(root, "projects/backend/.claude/skills/saber--context--dev")), /ENOENT/u);
    await assert.rejects(() => lstat(join(root, ".saber/runtime/mcp/claude/backend/mysql.json")), /ENOENT|ENOTDIR/u);
    await assert.rejects(() => lstat(join(root, ".saber/runtime/mcp/claude/backend/_active.json")), /ENOENT|ENOTDIR/u);
    await assert.rejects(() => lstat(join(root, ".saber/runtime/materialize/claude/backend.json")), /ENOENT/u);
    await assert.rejects(() => lstat(join(root, ".saber/runtime/transactions/materialize--claude--backend.json")), /ENOENT/u);
    await assert.rejects(() => lstat(join(root, ".saber/runtime/materialize/claude")), /ENOENT/u);
    await assert.rejects(() => lstat(join(root, ".saber/runtime/transactions")), /ENOENT/u);
    await assert.rejects(() => lstat(join(root, "projects/backend/.claude/skills")), /ENOENT/u);
    assert.equal((await lstat(join(root, "projects/backend/.claude"))).isDirectory(), true);
    assert.equal((await lstat(join(root, ".saber/runtime/mcp/claude"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialize uses exclusive random temporary files for native configuration", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await mkdir(join(root, "projects/backend/.git/info"), { recursive: true });
    await mkdir(join(root, "projects/backend/.mcp.json.tmp"), { recursive: true });

    const result = await materialize(root, config(), {
      role: "dev",
      tool: "claude",
      project: "backend",
      capabilities: ["mysql.read"],
    });

    assert.deepEqual(result.mcpServers, ["mysql"]);
    assert.equal((await lstat(join(root, "projects/backend/.mcp.json.tmp"))).isDirectory(), true);
    assert.match(await readFile(join(root, "projects/backend/.mcp.json"), "utf8"), /saber--mysql/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialize refuses tool paths whose parent redirects outside the repository", async () => {
  for (const tool of ["codex", "claude"] as const) {
    const root = await temporaryRoot();
    const outside = await mkdtemp(join(tmpdir(), `saber-materialize-${tool}-outside-`));
    try {
      await fixture(root);
      await symlink(outside, join(root, tool === "codex" ? ".codex" : ".claude"), "dir");

      await assert.rejects(
        () => materialize(root, config(), {
          role: "dev",
          tool,
          capabilities: ["mysql.read"],
        }),
        /unsafe parent|escapes repository root|could not restore the previous transaction/u,
      );
      await assert.rejects(() => lstat(join(outside, tool === "codex" ? "config.toml" : "skills")), /ENOENT/u);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
});

test("materialize recovers a different target transaction before writing new state", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex/config.toml"), "during interrupted materialize\n", "utf8");
    await mkdir(join(root, ".saber/runtime/transactions"), { recursive: true });
    const transactionPath = join(
      root,
      ".saber/runtime/transactions/materialize--codex--root.json",
    );
    await writeFile(
      transactionPath,
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
        files: [{ path: ".codex/config.toml", content: "before interrupted materialize\n" }],
        links: [],
        directories: [],
      })}\n`,
      "utf8",
    );

    await materialize(root, config(), { role: "qa", tool: "claude" });

    assert.equal(await readFile(join(root, ".codex/config.toml"), "utf8"), "before interrupted materialize\n");
    await assert.rejects(() => lstat(transactionPath), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capability switch removes only the previously managed native MCP entry and stale descriptor", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await mkdir(join(root, "projects/backend/.git/info"), { recursive: true });
    const configured = config();
    await materialize(root, configured, {
      role: "dev",
      tool: "claude",
      project: "backend",
      capabilities: ["mysql.read"],
    });

    const switched = await materialize(root, configured, {
      role: "qa",
      tool: "claude",
      project: "backend",
      capabilities: ["gitlab.mr.read"],
    });

    assert.deepEqual(switched.mcpServers, []);
    await assert.rejects(() => lstat(join(root, "projects/backend/.mcp.json")), /ENOENT/u);
    await assert.rejects(() => lstat(join(root, ".saber/runtime/mcp/claude/backend/mysql.json")), /ENOENT/u);
    const active = JSON.parse(
      await readFile(join(root, ".saber/runtime/mcp/claude/backend/_active.json"), "utf8"),
    ) as { descriptors: unknown[] };
    assert.deepEqual(active.descriptors, []);
    await assert.rejects(() => lstat(join(root, "projects/backend/.claude/skills/saber--context--dev")), /ENOENT/u);
    assert.equal((await lstat(join(root, "projects/backend/.claude/skills/saber--context--qa"))).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all supported tools receive the same project-level Saber MCP ownership entry", async () => {
  for (const tool of ["codex", "claude", "opencode"] as const) {
    const root = await temporaryRoot();
    try {
      await fixture(root);
      const result = await materialize(root, config(), {
        role: "qa",
        tool,
        capabilities: ["mysql.read"],
      });
      assert.deepEqual(result.mcpServers, ["mysql"]);
      const adapter = toolConfigAdapters[tool];
      const snapshot = adapter.inspect(await readFile(join(root, adapter.relativePath), "utf8"));
      const entry = snapshot.entries["saber--mysql"] as { args: string[] };
      assert.match(entry.args.at(-1)!, new RegExp(`mcp/${tool}/root/mysql\\.json$`, "u"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("missing external package returns an actionable recovery command", async () => {
  const root = await temporaryRoot();
  try {
    await fixture(root);
    await rm(join(root, ".saber/external/saber-v1/skills/superpowers/writing-plans"), {
      recursive: true,
      force: true,
    });
    const result = await runCli(
      ["materialize", "--tool", "codex", "--role", "dev", "--json"],
      {
        cwd: root,
        dependencies: { materializeCommand: { loadConfig: async () => config() } },
      },
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /saber external update/u);
    assert.match(result.stdout, /superpowers/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
