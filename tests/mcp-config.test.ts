import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { loadRepositoryConfig } from "../src/lib/config.js";
import { SaberError } from "../src/lib/errors.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const teamPrefix = `schemaVersion: 3
name: Example Team
workspace:
  tools:
    default: codex
  projects:
    - name: app
      path: projects/app
      capabilities: [mysql.read, idea.project.read]
externalSkills:
  preset: standard
`;

async function withConfig(
  team: string,
  local: string | undefined,
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "saber-mcp-config-"));
  try {
    await writeFile(join(root, "saber.yaml"), team, "utf8");
    if (local !== undefined) {
      await writeFile(join(root, "saber.local.yaml"), local, "utf8");
    }
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("schema v3 parses strict stdio and HTTP MCP servers with normalized defaults", async () => {
  const source = `${teamPrefix}mcp:
  servers:
    - id: idea
      transport: stdio
      command: node
      args: [tools/idea/server.js]
      cwd: .
      env: [IDEA_MCP_TOKEN]
      tools:
        - name: inspect_project
          capability: idea.project.read
    - id: mysql
      transport: http
      url: https://mcp.example.com/mysql
      headers:
        Authorization: MYSQL_MCP_AUTH
      tools:
        - name: query
          capability: mysql.read
`;

  await withConfig(source, undefined, async (root) => {
    const config = await loadRepositoryConfig(root);
    assert.deepEqual(config.mcp.servers, [
      {
        id: "idea",
        transport: "stdio",
        command: "node",
        args: ["tools/idea/server.js"],
        cwd: ".",
        env: ["IDEA_MCP_TOKEN"],
        tools: [{ name: "inspect_project", capability: "idea.project.read" }],
      },
      {
        id: "mysql",
        transport: "http",
        url: "https://mcp.example.com/mysql",
        headers: { Authorization: "MYSQL_MCP_AUTH" },
        tools: [{ name: "query", capability: "mysql.read" }],
      },
    ]);
    assert.deepEqual(config.local?.mcp.servers, []);
    assert.deepEqual(config.local?.extensions.mcpServers, []);
  });
});

test("schema v2 local config adds personal MCP servers and selects team servers", async () => {
  const team = `${teamPrefix}mcp:
  servers:
    - id: team-mysql
      transport: http
      url: https://mcp.example.com/mysql
      tools:
        - name: query
          capability: mysql.read
`;
  const local = `schemaVersion: 2
extensions:
  capabilities: [idea.project.read]
  mcpServers: [team-mysql]
mcp:
  servers:
    - id: personal-idea
      transport: stdio
      command: node
      tools:
        - name: inspect_project
          capability: idea.project.read
`;

  await withConfig(team, local, async (root) => {
    const config = await loadRepositoryConfig(root);
    assert.deepEqual(config.local?.extensions.mcpServers, ["team-mysql"]);
    assert.deepEqual(config.local?.mcp.servers, [
      {
        id: "personal-idea",
        transport: "stdio",
        command: "node",
        args: [],
        env: [],
        tools: [{ name: "inspect_project", capability: "idea.project.read" }],
      },
    ]);
  });
});

test("MCP schema rejects unknown fields and transport-specific field mixing", async () => {
  const invalidServers = [
    `id: unknown\n      transport: stdio\n      command: node\n      token: hidden\n      tools: []`,
    `id: mixed-stdio\n      transport: stdio\n      command: node\n      url: https://mcp.example.com\n      tools: []`,
    `id: mixed-http\n      transport: http\n      url: https://mcp.example.com\n      command: node\n      tools: []`,
    `id: unknown-tool-key\n      transport: stdio\n      command: node\n      tools:\n        - name: query\n          capability: mysql.read\n          extra: rejected`,
  ];

  for (const server of invalidServers) {
    await withConfig(`${teamPrefix}mcp:\n  servers:\n    - ${server}\n`, undefined, async (root) => {
      await assert.rejects(() => loadRepositoryConfig(root), SaberError);
    });
  }
});

test("MCP schema rejects duplicate IDs, tools, capabilities, and explicit selections", async () => {
  const invalidTeamConfigs = [
    `${teamPrefix}mcp:\n  servers:\n    - id: repeated\n      transport: stdio\n      command: node\n      tools: []\n    - id: repeated\n      transport: stdio\n      command: node\n      tools: []\n`,
    `${teamPrefix}mcp:\n  servers:\n    - id: repeated-tool\n      transport: stdio\n      command: node\n      tools:\n        - name: query\n          capability: mysql.read\n        - name: query\n          capability: jira.read\n`,
    `${teamPrefix}mcp:\n  servers:\n    - id: repeated-capability\n      transport: stdio\n      command: node\n      tools:\n        - name: first\n          capability: mysql.read\n        - name: second\n          capability: mysql.read\n`,
  ];
  for (const source of invalidTeamConfigs) {
    await withConfig(source, undefined, async (root) => {
      await assert.rejects(() => loadRepositoryConfig(root), SaberError);
    });
  }

  const team = `${teamPrefix}mcp:\n  servers:\n    - id: team\n      transport: stdio\n      command: node\n      tools: []\n`;
  await withConfig(
    team,
    "schemaVersion: 2\nextensions:\n  mcpServers: [team, team]\n",
    async (root) => assert.rejects(() => loadRepositoryConfig(root), SaberError),
  );
});

test("MCP schema rejects unsafe cwd, URL, removed auth modes, environment references, and unknown capabilities", async () => {
  const invalidServers = [
    `id: cwd-parent\n      transport: stdio\n      command: node\n      cwd: ../outside\n      tools: []`,
    `id: cwd-absolute\n      transport: stdio\n      command: node\n      cwd: /tmp\n      tools: []`,
    `id: command-parent\n      transport: stdio\n      command: ../outside/server\n      tools: []`,
    `id: command-absolute\n      transport: stdio\n      command: /tmp/server\n      tools: []`,
    `id: insecure-http\n      transport: http\n      url: http://mcp.example.com\n      tools: []`,
    `id: secret-url\n      transport: http\n      url: https://user:secret@mcp.example.com\n      tools: []`,
    `id: removed-auth-none\n      transport: http\n      url: https://mcp.example.com\n      auth: none\n      tools: []`,
    `id: removed-auth-oauth\n      transport: http\n      url: https://mcp.example.com\n      auth: oauth\n      tools: []`,
    `id: bad-env\n      transport: stdio\n      command: node\n      env: [not-an-env-name]\n      tools: []`,
    `id: repeated-env\n      transport: stdio\n      command: node\n      env: [TOKEN, TOKEN]\n      tools: []`,
    `id: unknown-capability\n      transport: stdio\n      command: node\n      tools:\n        - name: query\n          capability: custom.read`,
    `id: native-write\n      transport: stdio\n      command: node\n      tools:\n        - name: execute\n          capability: mysql.write`,
  ];
  for (const server of invalidServers) {
    await withConfig(`${teamPrefix}mcp:\n  servers:\n    - ${server}\n`, undefined, async (root) => {
      await assert.rejects(() => loadRepositoryConfig(root), SaberError);
    });
  }
});

test("personal MCP servers cannot shadow team servers or map L2 capabilities", async () => {
  const team = `${teamPrefix}mcp:
  servers:
    - id: shared
      transport: stdio
      command: node
      tools: []
`;
  const invalidLocalConfigs = [
    `schemaVersion: 2\nmcp:\n  servers:\n    - id: shared\n      transport: stdio\n      command: node\n      tools: []\n`,
    `schemaVersion: 2\nmcp:\n  servers:\n    - id: personal-write\n      transport: stdio\n      command: node\n      tools:\n        - name: execute\n          capability: mysql.write\n`,
    `schemaVersion: 2\nextensions:\n  mcpServers: [missing]\n`,
  ];

  for (const local of invalidLocalConfigs) {
    await withConfig(team, local, async (root) => {
      await assert.rejects(() => loadRepositoryConfig(root), SaberError);
    });
  }
});

test("only team schema v3 and local schema v2 are accepted", async () => {
  await withConfig(teamPrefix.replace("schemaVersion: 3", "schemaVersion: 2"), undefined, async (root) => {
    await assert.rejects(
      () => loadRepositoryConfig(root),
      (error: unknown) => error instanceof SaberError && /schemaVersion must be 3/u.test(error.message),
    );
  });
  await withConfig(teamPrefix, "schemaVersion: 1\n", async (root) => {
    await assert.rejects(
      () => loadRepositoryConfig(root),
      (error: unknown) => error instanceof SaberError && /schemaVersion must be 2/u.test(error.message),
    );
  });
});

test("checked-in team and personal examples enable no placeholder MCP servers", async () => {
  const config = await loadRepositoryConfig(repositoryRoot);
  const localExample = parse(
    await readFile(join(repositoryRoot, "saber.local.example.yaml"), "utf8"),
  ) as {
    extensions?: { mcpServers?: unknown };
    mcp?: { servers?: unknown };
  };

  assert.deepEqual(config.mcp.servers, []);
  assert.deepEqual(localExample.extensions?.mcpServers, []);
  assert.deepEqual(localExample.mcp?.servers, []);
});
