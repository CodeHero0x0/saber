import { parseBooleanArguments } from "../lib/argv.js";
import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import {
  executeExternalAssetUpdates,
  planExternalAssetUpdates,
  type CommandRunner,
  type ExternalAssetFileSystem,
  type ExternalAssetOperation,
} from "../lib/external-assets.js";
import type { RepositoryConfig } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";

export type ExternalCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExternalCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
  fileSystem?: ExternalAssetFileSystem;
  runner?: CommandRunner;
};

type ExternalListRequest = {
  action: "list";
  json: boolean;
};

type ExternalUpdateRequest = {
  action: "update";
  assetId?: string;
  apply: boolean;
  json: boolean;
};

type ExternalRequest = ExternalListRequest | ExternalUpdateRequest;

function parseExternalRequest(argv: readonly string[]): ExternalRequest {
  const [action, ...rest] = argv;
  if (action === undefined) {
    throw new SaberError("external command requires list or update", 2);
  }

  if (action === "list") {
    const parsed = parseBooleanArguments(rest, ["--json"]);
    if (parsed.positionals.length !== 0) {
      throw new SaberError("external list accepts no positional arguments", 2);
    }
    return { action, json: parsed.flags.has("--json") };
  }

  if (action === "update") {
    const parsed = parseBooleanArguments(rest, ["--apply", "--confirm", "--json"]);
    if (parsed.positionals.length > 1) {
      throw new SaberError("external update accepts at most one asset id", 2);
    }

    const apply = parsed.flags.has("--apply");
    const confirm = parsed.flags.has("--confirm");
    if (apply && !confirm) {
      throw new SaberError("--apply requires --confirm", 2);
    }
    if (confirm && !apply) {
      throw new SaberError("--confirm requires --apply", 2);
    }

    return {
      action,
      assetId: parsed.positionals[0],
      apply,
      json: parsed.flags.has("--json"),
    };
  }

  throw new SaberError("unknown external command", 2);
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatList(operations: readonly ExternalAssetOperation[]): string {
  const lines = ["External assets:"];
  for (const operation of operations) {
    lines.push(`- ${operation.assetId} [${operation.category}] ${operation.description}`);
    lines.push(`  source: ${operation.sourceStatus}`);
    lines.push(`  sparse cache: ${operation.cache} (${operation.state})`);
    lines.push(`  selected packages: ${operation.selectedPackages.length}`);
    for (const selectedPackage of operation.selectedPackages) {
      lines.push(
        `    - ${selectedPackage.id}: ${selectedPackage.sourcePath} -> ${selectedPackage.destination} (${selectedPackage.state})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatUpdate(
  operations: readonly ExternalAssetOperation[],
  mode: "dry-run" | "applied",
): string {
  const lines = [`External asset update (${mode}):`];
  for (const operation of operations) {
    lines.push(
      `- ${operation.assetId} [${operation.category}] ${operation.mode} (${operation.state})`,
    );
    if (operation.commands.length > 0) {
      for (const command of operation.commands) {
        lines.push(`  command: ${command.program} ${command.args.join(" ")}`);
      }
    } else {
      lines.push("  command: none (existing cache is not a Git checkout)");
    }
    for (const selectedPackage of operation.selectedPackages) {
      lines.push(
        `  package: ${selectedPackage.id} ${selectedPackage.mode} (${selectedPackage.state})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function externalConfigErrors(config: RepositoryConfig): void {
  const errors = validateRepositoryConfig(config);
  if (errors.length > 0) {
    throw new SaberError(`saber.yaml is invalid: ${errors.join("; ")}`, 2);
  }
}

function errorResult(error: unknown): ExternalCommandResult {
  if (error instanceof SaberError) {
    return { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
  }

  return { exitCode: 1, stdout: "", stderr: "external command failed\n" };
}

/** Run the explicit, manually-triggered external asset list/update subcommands. */
export async function runExternalCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: ExternalCommandDependencies },
): Promise<ExternalCommandResult> {
  try {
    const request = parseExternalRequest(argv);
    const loadConfig = dependencies.loadConfig ?? loadRepositoryConfig;
    const config = await loadConfig(cwd);
    externalConfigErrors(config);
    const planDependencies = { fileSystem: dependencies.fileSystem };

    if (request.action === "list") {
      const operations = await planExternalAssetUpdates(
        cwd,
        config.externalAssets,
        undefined,
        planDependencies,
      );
      const output = operations.map(
        ({ assetId, category, description, sourceStatus, cache, state, selectedPackages }) => ({
          id: assetId,
          category,
          description,
          sourceStatus,
          cache,
          cacheState: state,
          selectedPackageCount: selectedPackages.length,
          selectedPackages: selectedPackages.map(
            ({ id, sourcePath, destination, state: packageState }) => ({
              id,
              sourcePath,
              destination,
              destinationState: packageState,
            }),
          ),
        }),
      );
      return {
        exitCode: 0,
        stdout: request.json ? asJson({ assets: output }) : formatList(operations),
        stderr: "",
      };
    }

    const operations = await planExternalAssetUpdates(
      cwd,
      config.externalAssets,
      request.assetId,
      planDependencies,
    );
    const mode = request.apply ? "applied" : "dry-run";
    if (request.apply) {
      await executeExternalAssetUpdates(cwd, config.externalAssets, operations, {
        fileSystem: dependencies.fileSystem,
        runner: dependencies.runner,
      });
    }

    return {
      exitCode: 0,
      stdout: request.json
        ? asJson({ mode, operations })
        : formatUpdate(operations, mode),
      stderr: "",
    };
  } catch (error: unknown) {
    return errorResult(error);
  }
}
