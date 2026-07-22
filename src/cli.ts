#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runExternalCommand,
  type ExternalCommandDependencies,
} from "./commands/external.js";
import {
  runValidateCommand,
  type ValidateCommandDependencies,
} from "./commands/validate.js";
import {
  runDoctorCommand,
  type DoctorCommandDependencies,
} from "./commands/doctor.js";
import {
  runStatusCommand,
  type StatusCommandDependencies,
} from "./commands/status.js";
import {
  runInitCommand,
  type InitCommandDependencies,
} from "./commands/init.js";
import {
  runWorkitemCommand,
  type WorkitemCommandDependencies,
} from "./commands/workitem.js";
import {
  runActionCommand,
  type ActionCommandDependencies,
} from "./commands/action.js";
import {
  runMaterializeCommand,
  type MaterializeCommandDependencies,
} from "./commands/materialize.js";
import {
  runMcpCommand,
  type McpCommandDependencies,
} from "./commands/mcp.js";
import {
  runUninstallCommand,
  type UninstallCommandDependencies,
} from "./commands/uninstall.js";
import {
  runConvenienceCommand,
  type ConvenienceCommandDependencies,
} from "./commands/convenience.js";
import { SaberError } from "./lib/errors.js";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const usage = `Usage: saber <command>

Daily commands:
  saber setup [--apply --confirm] [--json]
  saber use <ba|dev|qa> [--tool <codex|claude|opencode>] [--project <name>] [--json]
  saber demo [DEMO-101] [--json]
  saber open <WORKITEM-KEY> [--json]
  saber loop <WORKITEM-KEY> [--json]
  saber next <WORKITEM-KEY> --result <result> [--summary <text>] [--risk <text>] [--next <text>] [--fingerprint <hash>] [--json]
  saber pause <WORKITEM-KEY> --reason <text> [--json]
  saber resume <WORKITEM-KEY> [--fingerprint <hash>] [--json]

Advanced commands:
  saber validate [--json]
  saber doctor [--json]
  saber status [--json]
  saber init [--apply --confirm] [--json]
  saber external list [--json]
  saber external update [id] [--apply --confirm] [--json]
  saber action preview <capability> --payload <json-file> [--json]
  saber action execute <capability> --payload <json-file> [--confirm <preview-token>] [--json]
  saber materialize [--tool <codex|claude|opencode>] --role <ba|dev|qa> [--project <name>] [--capability <id>] [--json]
  saber uninstall --tool <codex|claude|opencode> [--project <name>] [--apply --confirm <preview-token>] [--json]
  saber uninstall --all [--apply --confirm <preview-token>] [--json]
  saber mcp bridge --descriptor <path>
  saber workitem create [WORKITEM-KEY] --source-type <chat|jira|document|manual> --source-title <title> --source-file <path> [--source-origin <origin>] [--captured-at <ISO timestamp>] [--source-reference <reference>] --project <name> [--json]
  saber workitem handoff <WORKITEM-KEY> --role <ba|dev|qa> --summary <text> --risk <text> --next <text> [--fingerprint <hash>] [--json]
  saber workitem drift <WORKITEM-KEY> --fingerprint <hash> [--json]
  saber workitem status <WORKITEM-KEY> [--json]
`;

type ConvenienceCliDependencies = ConvenienceCommandDependencies & {
  runCommand?: typeof runConvenienceCommand;
};

export type CliDependencies = {
  externalCommand?: ExternalCommandDependencies;
  validateCommand?: ValidateCommandDependencies;
  doctorCommand?: DoctorCommandDependencies;
  statusCommand?: StatusCommandDependencies;
  initCommand?: InitCommandDependencies;
  workitemCommand?: WorkitemCommandDependencies;
  actionCommand?: ActionCommandDependencies;
  materializeCommand?: MaterializeCommandDependencies;
  mcpCommand?: McpCommandDependencies;
  uninstallCommand?: UninstallCommandDependencies;
  convenienceCommand?: ConvenienceCliDependencies;
};

export async function runCli(
  argv: readonly string[],
  {
    cwd = process.cwd(),
    dependencies,
  }: { cwd?: string; dependencies?: CliDependencies } = {},
): Promise<CliResult> {
  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: usage, stderr: "" };
  }

  if (command === "validate") {
    return runValidateCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.validateCommand,
    });
  }

  if (command === "doctor") {
    return runDoctorCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.doctorCommand,
    });
  }

  if (command === "status") {
    return runStatusCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.statusCommand,
    });
  }

  if (command === "init") {
    return runInitCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.initCommand,
    });
  }

  if (command === "external") {
    return runExternalCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.externalCommand,
    });
  }

  if (command === "workitem") {
    return runWorkitemCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.workitemCommand,
    });
  }

  if (command === "action") {
    return runActionCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.actionCommand,
    });
  }

  if (command === "materialize") {
    return runMaterializeCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.materializeCommand,
    });
  }

  if (command === "mcp") {
    return runMcpCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.mcpCommand,
    });
  }

  if (command === "uninstall") {
    return runUninstallCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.uninstallCommand,
    });
  }

  if (["setup", "use", "demo", "open", "loop", "next", "pause", "resume"].includes(command)) {
    const convenienceDependencies = dependencies?.convenienceCommand;
    return (convenienceDependencies?.runCommand ?? runConvenienceCommand)(
      command,
      argv.slice(1),
      { cwd, dependencies: convenienceDependencies },
    );
  }

  const error = new SaberError(`Unknown command: ${command}`, 2);
  return { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
}

const entrypoint = process.argv[1];
const isDirectExecution =
  entrypoint !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entrypoint));

if (isDirectExecution) {
  const result = await runCli(process.argv.slice(2));

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
