import { claudeToolConfig } from "./claude.js";
import { codexToolConfig } from "./codex.js";
import { opencodeToolConfig } from "./opencode.js";

export { claudeToolConfig, codexToolConfig, opencodeToolConfig };

export const toolConfigAdapters = {
  codex: codexToolConfig,
  claude: claudeToolConfig,
  opencode: opencodeToolConfig,
} as const;
export {
  createManagedMcpEntry,
  digestMcpValue,
  normalizedMcpValue,
  assertUniqueMcpObjectKeys,
  validateManagedEntries,
  type ManagedMcpEntry,
  type ToolConfigAdapter,
  type ToolConfigFormat,
  type ToolConfigSnapshot,
} from "./types.js";
