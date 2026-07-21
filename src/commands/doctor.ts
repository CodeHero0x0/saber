import { parseBooleanArguments } from "../lib/argv.js";
import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import {
  gitCommand,
  runSafeProcess,
  safeVersionLine,
  type SafeProcessRunner,
} from "../lib/git.js";
import { planExternalAssetUpdates, type ExternalAssetOperation } from "../lib/external-assets.js";
import type { RepositoryConfig, ToolName } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";

export type DoctorCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type DoctorConfigState =
  | { state: "valid"; errors: [] }
  | { state: "invalid"; errors: string[] };

export type DoctorReport = {
  node: { state: "available"; version: string };
  git: { state: "available"; version: string } | { state: "not-available" };
  config: DoctorConfigState;
  connectors: Array<{
    id: string;
    state: "configured" | "not-configured";
    missing: string[];
  }>;
  tools: Array<
    | { name: ToolName; state: "available"; version: string }
    | { name: ToolName; state: "not-available" }
  >;
  externalAssets:
    | {
        state: "inspected";
        assets: Array<{
          id: string;
          cacheState: ExternalAssetOperation["state"];
          updateMode: ExternalAssetOperation["mode"];
          selectedPackageCount: number;
        }>;
      }
    | { state: "not-inspected" };
};

export type DoctorCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
  env?: Readonly<Record<string, string | undefined>>;
  nodeVersion?: string;
  runner?: SafeProcessRunner;
  planExternalAssets?: (
    repositoryRoot: string,
    config: RepositoryConfig["externalAssets"],
  ) => Promise<readonly ExternalAssetOperation[]>;
};

const toolNames: readonly ToolName[] = ["codex", "claude", "opencode"];

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof SaberError) {
    return error.message;
  }
  return "could not read Saber configuration";
}

function isConfiguredEnvironmentValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

async function inspectGit(runner: SafeProcessRunner): Promise<DoctorReport["git"]> {
  try {
    const result = await runner(gitCommand(["--version"]));
    const version = safeVersionLine(result.stdout);
    if (result.exitCode === 0 && version !== undefined) {
      return { state: "available", version };
    }
  } catch {
    // A diagnostic must continue when one executable cannot start.
  }
  return { state: "not-available" };
}

async function inspectTools(
  runner: SafeProcessRunner,
): Promise<DoctorReport["tools"]> {
  const tools: DoctorReport["tools"] = [];
  for (const name of toolNames) {
    try {
      const result = await runner({ program: name, args: ["--version"], captureStdout: true });
      const version = safeVersionLine(result.stdout);
      if (result.exitCode === 0 && version !== undefined) {
        tools.push({ name, state: "available", version });
        continue;
      }
    } catch {
      // Keep probing the remaining tools independently.
    }
    tools.push({ name, state: "not-available" });
  }
  return tools;
}

async function inspectExternalAssets(
  repositoryRoot: string,
  config: RepositoryConfig,
  planExternalAssets: NonNullable<DoctorCommandDependencies["planExternalAssets"]>,
): Promise<DoctorReport["externalAssets"]> {
  try {
    const operations = await planExternalAssets(repositoryRoot, config.externalAssets);
    return {
      state: "inspected",
      assets: operations.map((operation) => ({
        id: operation.assetId,
        cacheState: operation.state,
        updateMode: operation.mode,
        selectedPackageCount: operation.selectedPackages.length,
      })),
    };
  } catch {
    // Plan failures can include machine-local filesystem state. Keep it out of
    // diagnostics and offer a deterministic state instead.
    return { state: "not-inspected" };
  }
}

/** Gather all local diagnostic checks. No network or external write is performed. */
export async function collectDoctorReport(
  repositoryRoot: string,
  dependencies: DoctorCommandDependencies = {},
): Promise<DoctorReport> {
  const runner = dependencies.runner ?? runSafeProcess;
  const environment = dependencies.env ?? process.env;
  const nodeVersion = safeVersionLine(dependencies.nodeVersion ?? process.version) ?? "unknown";
  const loadConfig = dependencies.loadConfig ?? loadRepositoryConfig;
  const externalPlanner = dependencies.planExternalAssets ?? planExternalAssetUpdates;
  let config: RepositoryConfig | undefined;
  let configState: DoctorConfigState;

  try {
    config = await loadConfig(repositoryRoot);
    const errors = validateRepositoryConfig(config);
    configState = errors.length === 0 ? { state: "valid", errors: [] } : { state: "invalid", errors };
  } catch (error: unknown) {
    configState = { state: "invalid", errors: [safeErrorMessage(error)] };
  }

  const [git, tools] = await Promise.all([inspectGit(runner), inspectTools(runner)]);
  if (config === undefined || configState.state === "invalid") {
    return {
      node: { state: "available", version: nodeVersion },
      git,
      config: configState,
      connectors: [],
      tools,
      externalAssets: { state: "not-inspected" },
    };
  }

  const connectors = config.connectors.map((connector) => {
    const missing = connector.requiredEnv.filter(
      (name) => !isConfiguredEnvironmentValue(environment[name]),
    );
    return {
      id: connector.id,
      state: missing.length === 0 ? ("configured" as const) : ("not-configured" as const),
      missing,
    };
  });

  return {
    node: { state: "available", version: nodeVersion },
    git,
    config: configState,
    connectors,
    tools,
    externalAssets: await inspectExternalAssets(repositoryRoot, config, externalPlanner),
  };
}

function formatDoctorReport(report: DoctorReport): string {
  const lines = ["Saber doctor:", `- Node: ${report.node.version}`];
  lines.push(
    report.git.state === "available" ? `- Git: ${report.git.version}` : "- Git: not available",
  );
  lines.push(
    report.config.state === "valid"
      ? "- Configuration: valid"
      : `- Configuration: invalid (${report.config.errors.length} issue${report.config.errors.length === 1 ? "" : "s"})`,
  );
  for (const connector of report.connectors) {
    lines.push(
      connector.state === "configured"
        ? `- Connector ${connector.id}: configured`
        : `- Connector ${connector.id}: not configured (missing: ${connector.missing.join(", ")})`,
    );
  }
  for (const tool of report.tools) {
    lines.push(
      tool.state === "available"
        ? `- Tool ${tool.name}: ${tool.version}`
        : `- Tool ${tool.name}: not available`,
    );
  }
  lines.push(
    report.externalAssets.state === "inspected"
      ? `- External assets: inspected (${report.externalAssets.assets.length})`
      : "- External assets: not inspected",
  );
  return `${lines.join("\n")}\n`;
}

/** Run `saber doctor [--json]`. */
export async function runDoctorCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: DoctorCommandDependencies },
): Promise<DoctorCommandResult> {
  const requestedJson = argv.includes("--json");
  try {
    const parsed = parseBooleanArguments(argv, ["--json"]);
    if (parsed.positionals.length > 0) {
      throw new SaberError("doctor accepts no positional arguments", 2);
    }
    const report = await collectDoctorReport(cwd, dependencies);
    return {
      exitCode: report.config.state === "valid" ? 0 : 2,
      stdout: parsed.flags.has("--json") ? asJson(report) : formatDoctorReport(report),
      stderr: "",
    };
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      return requestedJson
        ? {
            exitCode: error.exitCode,
            stdout: asJson({ valid: false, errors: [error.message] }),
            stderr: "",
          }
        : { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
    }
    return requestedJson
      ? {
          exitCode: 1,
          stdout: asJson({ valid: false, errors: ["doctor command failed"] }),
          stderr: "",
        }
      : { exitCode: 1, stdout: "", stderr: "doctor command failed\n" };
  }
}
