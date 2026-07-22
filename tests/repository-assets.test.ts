import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { loadRepositoryConfig } from "../src/lib/config.js";
import { validateRepositoryConfig } from "../src/lib/validation.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseSkill(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(content);
  assert.ok(match, "skill must have YAML frontmatter and a non-empty body");
  const frontmatter = parse(match[1] ?? "") as Record<string, unknown>;
  return { frontmatter, body: match[2] ?? "" };
}

const expectedCapabilities = {
  "jira.read": { risk: "L0", kind: "read" },
  "jira.update": { risk: "L2", kind: "action" },
  "gitlab.mr.read": { risk: "L0", kind: "read" },
  "gitlab.mr.create": { risk: "L2", kind: "action" },
  "git.push": { risk: "L2", kind: "action" },
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
  assert.deepEqual(config.mcp.servers, []);
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
  assert.equal(connectorById.get("git")?.kind, "git-cli");
  assert.equal(connectorById.has("idea-mcp"), false);
  assert.equal(connectorById.has("mysql-mcp"), false);
  assert.equal(capabilityById.get("idea.project.read")?.connector, undefined);
  assert.equal(capabilityById.get("mysql.read")?.connector, undefined);

  for (const connector of config.connectors) {
    for (const name of connector.requiredEnv) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/u);
    }
    for (const capabilityId of connector.provides) {
      assert.ok(capabilityById.has(capabilityId), `${connector.id} provides ${capabilityId}`);
    }
  }
});

test("saber.yaml stays minimal while the preset keeps connector values unset", async () => {
  const content = await readFile(join(repositoryRoot, "saber.yaml"), "utf8");
  const parsed = parse(content) as { mcp?: { servers?: unknown } };
  const environmentNames = [
    "JIRA_BASE_URL",
    "JIRA_ACCOUNT_ID",
    "JIRA_API_TOKEN",
    "GITLAB_BASE_URL",
    "GITLAB_ACCOUNT_ID",
    "GITLAB_API_TOKEN",
    "GIT_PUSH_ACCOUNT_ID",
  ];

  for (const section of ["workspace", "externalSkills"]) {
    assert.match(content, new RegExp(`^${section}:`, "mu"));
  }
  assert.match(content, /^schemaVersion: 3$/mu);
  assert.deepEqual(parsed.mcp?.servers, []);
  assert.match(content, /^\s+preset: standard$/mu);
  assert.doesNotMatch(content, /^(?:safety|capabilities|connectors|externalAssets|roleProfiles):/mu);
  for (const name of environmentNames) {
    assert.doesNotMatch(content, new RegExp(name, "u"));
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

test("local configuration is ignored while its documented example is tracked", async () => {
  const [ignore, example] = await Promise.all([
    readFile(join(repositoryRoot, ".gitignore"), "utf8"),
    readFile(join(repositoryRoot, "saber.local.example.yaml"), "utf8"),
  ]);
  assert.match(ignore, /^\/saber\.local\.yaml$/mu);
  assert.match(example, /^schemaVersion: 2$/mu);
  assert.match(example, /^defaults:$/mu);
  assert.match(example, /^projects:$/mu);
  assert.match(example, /^extensions:$/mu);
  const parsedExample = parse(example) as {
    extensions?: { mcpServers?: unknown };
    mcp?: { servers?: unknown };
  };
  assert.deepEqual(parsedExample.extensions?.mcpServers, []);
  assert.deepEqual(parsedExample.mcp?.servers, []);
});

test(".env.example documents every connector variable without shipping credentials", async () => {
  const content = await readFile(join(repositoryRoot, ".env.example"), "utf8");
  for (const name of [
    "JIRA_BASE_URL",
    "JIRA_ACCOUNT_ID",
    "JIRA_API_TOKEN",
    "GITLAB_BASE_URL",
    "GITLAB_ACCOUNT_ID",
    "GITLAB_API_TOKEN",
    "GIT_PUSH_ACCOUNT_ID",
    "MYSQL_MCP_AUTH",
    "IDEA_MCP_TOKEN",
  ]) {
    assert.match(content, new RegExp(`^${name}=`, "mu"));
  }
  assert.match(content, /JIRA_API_TOKEN=""/u);
  assert.match(content, /GITLAB_API_TOKEN=""/u);
  assert.doesNotMatch(content, /(?:MYSQL|IDEA)_MCP_COMMAND/u);
  assert.doesNotMatch(content, /(?:ghp_|glpat-|sk-[A-Za-z0-9])/u);
});

test("role, workflow, and skill assets retain their minimum usable contracts", async () => {
  const roleFiles = ["ba.md", "dev.md", "qa.md"];
  const roleSections = ["Responsible human", "Required input", "Output", "Handoff", "Tool interaction"];

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
    assert.match(content, /\/saber/u, `${workflow} lacks the tool-native Saber entrypoint`);
    assert.doesNotMatch(content, /saber (?:open|next|loop|pause|resume) /u, `${workflow} exposes internal CLI`);
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

test("team skills ship linked reusable references, templates, and checklists", async () => {
  const skillPackages = [
    [
      "grill-me",
      ["references/question-bank.md", "templates/decision-record.md"],
    ],
    [
      "grill-with-docs",
      ["references/evidence-rubric.md", "templates/cited-decision-record.md"],
    ],
    [
      "superpowers",
      ["references/workflow-routing.md", "checklists/selection-checklist.md"],
    ],
    [
      "openspec",
      [
        "templates/change-proposal.md",
        "templates/archive-record.md",
        "checklists/lifecycle-checklist.md",
      ],
    ],
  ] as const;

  for (const [skill, artifactPaths] of skillPackages) {
    const skillPath = join(repositoryRoot, "skills", skill, "SKILL.md");
    const skillContent = await readFile(skillPath, "utf8");

    for (const artifactPath of artifactPaths) {
      assert.ok(
        skillContent.includes(`](${artifactPath})`),
        `${skill} must link ${artifactPath}`,
      );
      const artifactContent = await readFile(
        join(repositoryRoot, "skills", skill, artifactPath),
        "utf8",
      );
      assert.match(artifactContent, /^# /mu, `${artifactPath} needs a useful title`);
      assert.ok(artifactContent.trim().length >= 160, `${artifactPath} must not be a stub`);
    }
  }
});

test("tool-native Saber commands have valid frontmatter and Chinese single-purpose contracts", async () => {
  const commandSkills = [
    "saber",
    "saber-intake",
    "saber-focus",
    "saber-status",
    "saber-refine",
    "saber-help",
  ] as const;

  for (const name of commandSkills) {
    const content = await readFile(join(repositoryRoot, "skills", name, "SKILL.md"), "utf8");
    const { frontmatter, body } = parseSkill(content);
    assert.equal(frontmatter.name, name);
    assert.equal(typeof frontmatter.description, "string");
    assert.ok((frontmatter.description as string).trim().length > 0);
    assert.equal(frontmatter["user-invocable"], true);
    assert.match(body, /[\u3400-\u9fff]/u, `${name} must provide Chinese instructions`);
  }

  const focus = await readFile(join(repositoryRoot, "skills/saber-focus/SKILL.md"), "utf8");
  const status = await readFile(join(repositoryRoot, "skills/saber-status/SKILL.md"), "utf8");
  const help = await readFile(join(repositoryRoot, "skills/saber-help/SKILL.md"), "utf8");
  assert.match(focus, /加载[\s\S]*(?:工作项|上下文)[\s\S]*(?:证据|仓库)/u);
  assert.match(status, /只读[\s\S]*(?:进度|状态)[\s\S]*(?:缺失|缺口)/u);
  assert.match(help, /帮助[\s\S]*(?:当前阶段|可做事项)/u);
  for (const content of [focus, status, help]) {
    assert.doesNotMatch(content, /创建工作项/u);
    assert.doesNotMatch(content, /执行外部写入/u);
  }
});

test("the /saber entrypoint fixes routing order and preserves the authorization boundary", async () => {
  const content = await readFile(join(repositoryRoot, "skills/saber/SKILL.md"), "utf8");
  const routingReference = await readFile(
    join(repositoryRoot, "skills/saber/references/role-routing.md"),
    "utf8",
  );
  const explicitIntent = content.indexOf("用户显式角色或动作");
  const workitemOwner = content.indexOf("已有工作项状态责任角色");
  const defaultRole = content.indexOf("当前物化默认角色");
  const semanticInference = content.indexOf("语义推断");
  const clarification = content.indexOf("一个最小澄清问题");

  assert.ok(explicitIntent >= 0, "missing explicit role/action routing priority");
  assert.ok(explicitIntent < workitemOwner, "explicit intent must outrank workitem state");
  assert.ok(workitemOwner < defaultRole, "workitem owner must outrank materialized default role");
  assert.ok(defaultRole < semanticInference, "default role must outrank semantic inference");
  assert.ok(semanticInference < clarification, "semantic inference must precede clarification");
  assert.match(content, /唯一主要入口/u);
  assert.match(content, /\]\(references\/role-routing\.md\)/u);
  assert.match(routingReference, /^# /u);
  assert.ok(routingReference.trim().length >= 160);
  assert.match(content, /角色(?:档案)?(?:只是|仅是|仅作为)上下文[^\n]*不是授权/u);
  assert.match(content, /L2[\s\S]*action preview[\s\S]*精确[\s\S]*(?:确认|confirm)[\s\S]*(?:token|令牌)/iu);
  assert.match(content, /L3[^\n]*(?:禁止|禁用)/u);
  assert.match(content, /workitem create[\s\S]*--source-type[\s\S]*--source-file/u);
  assert.match(content, /workitem status[\s\S]*saber next/u);
});

test("intake and refine keep drafts, sources, and explicit grilling safe", async () => {
  const intake = await readFile(join(repositoryRoot, "skills/saber-intake/SKILL.md"), "utf8");
  const refine = await readFile(join(repositoryRoot, "skills/saber-refine/SKILL.md"), "utf8");
  const grill = await readFile(join(repositoryRoot, "skills/grill-me/SKILL.md"), "utf8");
  const grillWithDocs = await readFile(
    join(repositoryRoot, "skills/grill-with-docs/SKILL.md"),
    "utf8",
  );

  assert.match(intake, /中文[\s\S]*(?:逐项|一次一个|一次只问一个)[\s\S]*(?:草稿|需求草案)/u);
  assert.match(intake, /展示[\s\S]*草稿[\s\S]*用户确认[\s\S]*(?:之后|后)[\s\S]*创建工作项/u);
  assert.match(intake, /(?:文件|--source-file)[\s\S]*(?:后台|内部)[\s\S]*(?:CLI|命令行)/iu);
  assert.match(intake, /不(?:把|允许)[^\n]*(?:短文本|--source-text)[^\n]*(?:CLI|命令行)/iu);
  assert.match(intake, /不(?:保存|落盘)[^\n]*完整聊天/u);
  assert.match(intake, /source\.kind[\s\S]*jira/u);

  assert.match(refine, /文档/u);
  assert.match(refine, /用户显式[\s\S]*\/grill-me[\s\S]*\/grill-with-docs/u);
  assert.match(refine, /disable-model-invocation/u);
  assert.doesNotMatch(refine, /自动(?:调用|触发)[^\n]*\/grill-(?:me|with-docs)/u);

  for (const [name, content] of [
    ["grill-me", grill],
    ["grill-with-docs", grillWithDocs],
  ] as const) {
    const { frontmatter, body } = parseSkill(content);
    assert.equal(frontmatter["disable-model-invocation"], true, `${name} must stay user-triggered`);
    assert.match(body, new RegExp(`用户显式[\\s\\S]*/${name}`, "u"));
    assert.match(body, /Saber[\s\S]*(?:草稿|草案)/u);
    assert.doesNotMatch(body, /自动(?:调用|触发)[^\n]*\/grill-(?:me|with-docs)/u);
  }
  assert.match(grillWithDocs, /Saber[\s\S]*(?:文档|引用)[\s\S]*(?:草稿|草案)/u);

  for (const content of [intake, refine, grill, grillWithDocs]) {
    assert.doesNotMatch(content, /旧\s*(?:Jira\s*)?schema|兼容旧|映射旧|自动升级/u);
  }
});
