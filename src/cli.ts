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
import { SaberError } from "./lib/errors.js";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const usage = `Usage: saber <command>

Commands:
  saber validate [--json]
  saber doctor [--json]
  saber status [--json]
  saber init [--apply --confirm] [--json]
  saber external list [--json]
  saber external update [id] [--apply --confirm] [--json]
  saber workitem create <JIRA-KEY> --jira-url <url> --fingerprint <hash> [--updated-at <ISO timestamp>] --project <name> [--project <name>] [--json]
  saber workitem handoff <JIRA-KEY> --role <ba|dev|qa> --summary <text> --risk <text> --next <text> [--fingerprint <hash>] [--json]
  saber workitem drift <JIRA-KEY> --fingerprint <hash> [--json]
  saber workitem status <JIRA-KEY> [--json]
`;

export type CliDependencies = {
  externalCommand?: ExternalCommandDependencies;
  validateCommand?: ValidateCommandDependencies;
  doctorCommand?: DoctorCommandDependencies;
  statusCommand?: StatusCommandDependencies;
  initCommand?: InitCommandDependencies;
  workitemCommand?: WorkitemCommandDependencies;
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
