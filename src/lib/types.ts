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

export type SaberConfig = {
  schemaVersion: 1;
  projects: SaberProject[];
  skills: {
    source: string;
    include: string[];
  };
};
