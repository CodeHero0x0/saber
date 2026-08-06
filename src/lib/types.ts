export const toolDiscoveryDirectories = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  opencode: ".opencode/skills",
} as const;

export type ToolName = keyof typeof toolDiscoveryDirectories;

export type SaberProject = {
  name: string;
  path: string;
  repository?: string;
};

export type SaberSkillSource = {
  id: string;
  repository: string;
  ref: string;
  include: string[];
};

export type SaberConfig = {
  schemaVersion: 2;
  projects: SaberProject[];
  skills: {
    sources: SaberSkillSource[];
  };
  loop: {
    evidenceBranch: string;
    maxIterations: number;
    maxNoProgressIterations: number;
    maxMinutes: number;
  };
};
