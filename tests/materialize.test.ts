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
      { id: "mysql.read", risk: "L0", kind: "read", connector: "mysql-mcp" },
    ],
    connectors: [
      { id: "jira", kind: "http", requiredEnv: ["JIRA_BASE_URL", "JIRA_API_TOKEN"], provides: ["jira.read"] },
      { id: "gitlab", kind: "http", requiredEnv: ["GITLAB_BASE_URL", "GITLAB_API_TOKEN"], provides: ["gitlab.mr.read"] },
      { id: "mysql-mcp", kind: "mcp-command", requiredEnv: ["MYSQL_MCP_COMMAND"], provides: ["mysql.read"] },
    ],
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
    assert.deepEqual(result.externalSkills, ["superpowers/writing-plans"]);
    assert.ok(result.projections.every((projection) => projection.linkPath.startsWith(".agents/skills/saber--")));
    assert.equal(result.projections.length, 4);
    for (const projection of result.projections) {
      assert.equal((await lstat(join(root, projection.linkPath))).isSymbolicLink(), true);
      assert.ok((await readlink(join(root, projection.linkPath))).length > 0);
    }
    const manifest = JSON.parse(await readFile(join(root, result.manifestPath), "utf8")) as {
      capabilities: string[];
    };
    assert.deepEqual(manifest.capabilities, ["jira.read", "gitlab.mr.read"]);
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
        projections: [
          {
            name: "saber--context--dev",
            kind: "context",
            linkPath: ".agents/personal-link",
            sourcePath: "skills/grill-me",
          },
        ],
      })}\n`,
      "utf8",
    );

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

test("all supported tools use their native discovery directory", async () => {
  const roots: Record<ToolName, string> = {
    codex: ".agents/skills",
    claude: ".claude/skills",
    opencode: ".opencode/skills",
  };
  for (const tool of Object.keys(roots) as ToolName[]) {
    const root = await temporaryRoot();
    try {
      await fixture(root);
      const result = await materialize(root, config(), { role: "qa", tool });
      assert.equal(result.discoveryRoot, roots[tool]);
      assert.ok(result.projections.every((projection) => projection.linkPath.startsWith(roots[tool])));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    assert.match(
      await readFile(join(root, "projects/backend/.git/info/exclude"), "utf8"),
      /\.claude\/skills\/saber--\*/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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
