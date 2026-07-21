export type RiskLevel = "L0" | "L1" | "L2" | "L3";

export type ToolName = "codex" | "claude" | "opencode";

export type Capability = {
  id: string;
  risk: RiskLevel;
  kind: "read" | "action";
  connector?: string;
};

export type ProjectConfig = {
  name: string;
  path: string;
  repository?: string;
  capabilities?: string[];
};

export type WorkspaceConfig = {
  schemaVersion: 1;
  tools: {
    default: ToolName;
    supported?: ToolName[];
    defaultCapabilities?: string[];
  };
  projects: ProjectConfig[];
};

export type ConnectorKind = "http" | "mcp-command";

export type ConnectorConfig = {
  id: string;
  kind: ConnectorKind;
  requiredEnv: string[];
  provides: string[];
};

export type SaberConfig = {
  schemaVersion: 1;
  name: string;
  safety: {
    externalWrites: "preview-and-confirm";
    forbiddenRiskLevels: RiskLevel[];
  };
};

export type ExternalAssetKind = "git";

/** A registry category keeps skills and future MCP packages distinguishable. */
export type ExternalAssetCategory = "skill-collection" | "mcp-server";

/** A selected source subtree that can be installed without exposing its whole upstream repository. */
export type ExternalAssetPackage = {
  id: string;
  sourcePath: string;
};

export type ExternalAsset = {
  id: string;
  category: ExternalAssetCategory;
  description: string;
  kind: ExternalAssetKind;
  source: string;
  packages: ExternalAssetPackage[];
};

export type ExternalAssetsConfig = {
  schemaVersion: 1;
  assets: ExternalAsset[];
};

export type RepositoryConfig = {
  saber: SaberConfig;
  workspace: WorkspaceConfig;
  capabilities: Capability[];
  connectors: ConnectorConfig[];
  externalAssets: ExternalAssetsConfig;
};

export type RepositoryValidationInput = Pick<
  RepositoryConfig,
  "workspace" | "capabilities" | "connectors"
> & {
  externalAssets?: ExternalAssetsConfig;
};
