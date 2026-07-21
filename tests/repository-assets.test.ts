import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRepositoryConfig } from "../src/lib/config.js";
import { validateRepositoryConfig } from "../src/lib/validation.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const expectedCapabilities = {
  "jira.read": { risk: "L0", kind: "read" },
  "jira.update": { risk: "L2", kind: "action" },
  "gitlab.mr.read": { risk: "L0", kind: "read" },
  "gitlab.mr.create": { risk: "L2", kind: "action" },
  "mysql.read": { risk: "L0", kind: "read" },
  "mysql.write": { risk: "L2", kind: "action" },
  "idea.project.read": { risk: "L0", kind: "read" },
  "idea.command.execute": { risk: "L2", kind: "action" },
  "external.assets.update": { risk: "L1", kind: "action" },
} as const;

test("the checked-in catalog has every required capability and safe connector template", async () => {
  const config = await loadRepositoryConfig(repositoryRoot);
  const capabilityById = new Map(
    config.capabilities.map((capability) => [capability.id, capability]),
  );

  assert.deepEqual(validateRepositoryConfig(config), []);
  assert.deepEqual(config.workspace.tools.supported, ["codex", "claude", "opencode"]);
  assert.deepEqual(config.workspace.projects.map((project) => project.name), ["frontend", "backend"]);

  for (const [id, expected] of Object.entries(expectedCapabilities)) {
    const capability = capabilityById.get(id);
    assert.ok(capability, `missing ${id}`);
    assert.equal(capability.risk, expected.risk);
    assert.equal(capability.kind, expected.kind);
  }

  const connectorById = new Map(config.connectors.map((connector) => [connector.id, connector]));
  assert.equal(connectorById.get("jira")?.kind, "http");
  assert.equal(connectorById.get("gitlab")?.kind, "http");
  assert.equal(connectorById.get("idea-mcp")?.kind, "mcp-command");
  assert.equal(connectorById.get("mysql-mcp")?.kind, "mcp-command");

  for (const connector of config.connectors) {
    assert.ok(connector.requiredEnv.length > 0, `${connector.id} needs environment names`);
    for (const name of connector.requiredEnv) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/u);
    }
    for (const capabilityId of connector.provides) {
      assert.ok(capabilityById.has(capabilityId), `${connector.id} provides ${capabilityId}`);
    }
  }
});

test("saber.yaml is the single repository configuration and connector values stay unset", async () => {
  const content = await readFile(join(repositoryRoot, "saber.yaml"), "utf8");
  const environmentNames = [
    "IDEA_MCP_COMMAND",
    "MYSQL_MCP_COMMAND",
    "JIRA_BASE_URL",
    "JIRA_API_TOKEN",
    "GITLAB_BASE_URL",
    "GITLAB_API_TOKEN",
  ];

  for (const section of ["workspace", "capabilities", "connectors", "externalAssets"]) {
    assert.match(content, new RegExp(`^${section}:`, "mu"));
  }
  for (const name of environmentNames) {
    assert.match(content, new RegExp(`^\\s*- ${name}$`, "mu"));
    assert.doesNotMatch(content, new RegExp(`^\\s*${name}\\s*:`, "mu"));
  }

  for (const retiredPath of [
    "workspace.yaml",
    "external-assets.yaml",
    "mcp/capabilities.yaml",
    "mcp/connectors/jira.yaml",
    "mcp/connectors/gitlab.yaml",
    "mcp/connectors/idea-mcp.yaml",
    "mcp/connectors/mysql-mcp.yaml",
  ]) {
    await assert.rejects(access(join(repositoryRoot, retiredPath)), { code: "ENOENT" });
  }
});

test("role, workflow, and skill assets retain their minimum usable contracts", async () => {
  const roleFiles = ["ba.md", "dev.md", "qa.md"];
  const roleSections = ["Responsible human", "Required input", "Output", "Handoff"];

  for (const filename of roleFiles) {
    const content = await readFile(join(repositoryRoot, "roles", filename), "utf8");
    for (const section of roleSections) {
      assert.match(content, new RegExp(`## ${section}`, "u"), `${filename} lacks ${section}`);
    }
  }

  const workflowFiles = ["requirements", "develop", "test", "fix"];
  const workflowSections = ["Entry conditions", "Steps", "Artifacts", "Gate", "Pause condition"];

  for (const workflow of workflowFiles) {
    const content = await readFile(
      join(repositoryRoot, "workflows", workflow, "SKILL.md"),
      "utf8",
    );
    for (const section of workflowSections) {
      assert.match(content, new RegExp(`## ${section}`, "u"), `${workflow} lacks ${section}`);
    }
  }

  const skillExpectations = [
    ["grill-me", /question|risk|acceptance/iu],
    ["grill-with-docs", /citation|documentation|authoritative/iu],
    ["superpowers", /brainstorming|writing-plans|systematic-debugging/iu],
    ["openspec", /explore[\s\S]*propose[\s\S]*apply[\s\S]*archive/iu],
  ] as const;

  for (const [skill, expectedContent] of skillExpectations) {
    const content = await readFile(join(repositoryRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(content, expectedContent, `${skill} does not contain usable instructions`);
  }
});
