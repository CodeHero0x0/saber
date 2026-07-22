import type { RepositoryConfig } from "./models.js";

const standardPreset: RepositoryConfig = {
  saber: {
    schemaVersion: 1,
    name: "Saber",
    safety: {
      externalWrites: "preview-and-confirm",
      forbiddenRiskLevels: ["L3"],
    },
  },
  workspace: {
    schemaVersion: 1,
    tools: {
      default: "codex",
      supported: ["codex", "claude", "opencode"],
      defaultCapabilities: ["jira.read", "gitlab.mr.read", "idea.project.read"],
    },
    projects: [],
  },
  mcp: {
    servers: [],
  },
  roleProfiles: [
    {
      id: "ba",
      teamSkills: ["grill-me", "grill-with-docs", "openspec"],
      externalSkills: ["openspec/openspec-explore", "openspec/openspec-propose"],
      workflows: ["requirements"],
      capabilities: ["jira.read", "gitlab.mr.read"],
    },
    {
      id: "dev",
      teamSkills: ["superpowers", "grill-me", "openspec"],
      externalSkills: [
        "superpowers/writing-plans",
        "superpowers/systematic-debugging",
        "superpowers/verification-before-completion",
        "openspec/openspec-apply-change",
      ],
      workflows: ["develop", "fix"],
      capabilities: ["jira.read", "gitlab.mr.read", "git.push"],
    },
    {
      id: "qa",
      teamSkills: ["superpowers", "grill-with-docs"],
      externalSkills: [
        "superpowers/systematic-debugging",
        "superpowers/requesting-code-review",
        "superpowers/verification-before-completion",
      ],
      workflows: ["test", "fix"],
      capabilities: ["jira.read", "gitlab.mr.read"],
    },
  ],
  capabilities: [
    { id: "jira.read", risk: "L0", kind: "read", connector: "jira" },
    { id: "jira.update", risk: "L2", kind: "action", connector: "jira" },
    { id: "gitlab.mr.read", risk: "L0", kind: "read", connector: "gitlab" },
    { id: "gitlab.mr.create", risk: "L2", kind: "action", connector: "gitlab" },
    { id: "git.push", risk: "L2", kind: "action", connector: "git" },
    { id: "mysql.read", risk: "L0", kind: "read" },
    { id: "mysql.write", risk: "L2", kind: "action" },
    { id: "idea.project.read", risk: "L0", kind: "read" },
    { id: "idea.command.execute", risk: "L2", kind: "action" },
    { id: "external.assets.update", risk: "L1", kind: "action" },
  ],
  connectors: [
    {
      id: "git",
      kind: "git-cli",
      requiredEnv: ["GIT_PUSH_ACCOUNT_ID"],
      provides: ["git.push"],
    },
    {
      id: "jira",
      kind: "http",
      requiredEnv: ["JIRA_BASE_URL", "JIRA_ACCOUNT_ID", "JIRA_API_TOKEN"],
      provides: ["jira.read", "jira.update"],
    },
    {
      id: "gitlab",
      kind: "http",
      requiredEnv: ["GITLAB_BASE_URL", "GITLAB_ACCOUNT_ID", "GITLAB_API_TOKEN"],
      provides: ["gitlab.mr.read", "gitlab.mr.create"],
    },
  ],
  externalAssets: {
    schemaVersion: 1,
    assets: [
      {
        id: "superpowers",
        category: "skill-collection",
        description: "团队可按需拉取的 Superpowers 技能集合。",
        kind: "git",
        source: "https://github.com/obra/superpowers.git",
        packages: [
          { id: "brainstorming", sourcePath: "skills/brainstorming" },
          { id: "writing-plans", sourcePath: "skills/writing-plans" },
          { id: "executing-plans", sourcePath: "skills/executing-plans" },
          { id: "systematic-debugging", sourcePath: "skills/systematic-debugging" },
          {
            id: "verification-before-completion",
            sourcePath: "skills/verification-before-completion",
          },
          { id: "requesting-code-review", sourcePath: "skills/requesting-code-review" },
        ],
      },
      {
        id: "openspec",
        category: "skill-collection",
        description: "团队可按需拉取的 OpenSpec 规格工作流技能集合。",
        kind: "git",
        source: "https://github.com/Fission-AI/OpenSpec.git",
        packages: [
          { id: "openspec-explore", sourcePath: "skills/openspec-explore" },
          { id: "openspec-propose", sourcePath: "skills/openspec-propose" },
          { id: "openspec-apply-change", sourcePath: "skills/openspec-apply-change" },
          { id: "openspec-archive-change", sourcePath: "skills/openspec-archive-change" },
        ],
      },
    ],
  },
};

/** Return an independent standard configuration so callers can safely apply overrides. */
export function createStandardPreset(): RepositoryConfig {
  return structuredClone(standardPreset);
}
