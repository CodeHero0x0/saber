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
  runKnowledgeCommand,
  type KnowledgeCommandDependencies,
} from "./commands/knowledge.js";
import {
  runActionCommand,
  type ActionCommandDependencies,
} from "./commands/action.js";
import {
  runMaterializeCommand,
  type MaterializeCommandDependencies,
} from "./commands/materialize.js";
import {
  runUninstallCommand,
  type UninstallCommandDependencies,
} from "./commands/uninstall.js";
import { SaberError } from "./lib/errors.js";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const usage = `Usage: saber <command>

Member command:
  saber init [--tool <codex|claude|opencode>] [--json]

Internal and administrator commands:
  saber validate [--json]
  saber doctor [--json]
  saber status [--json]
  saber external list [--json]
  saber external update [id] [--apply --confirm] [--json]
  saber action preview <capability> --payload <json-file> [--json]
  saber action execute <capability> --payload <json-file> [--confirm <preview-token>] [--json]
  saber materialize [--tool <codex|claude|opencode>] [--capability <id>] [--json]
  saber uninstall --tool <codex|claude|opencode> [--apply --confirm <preview-token>] [--json]
  saber uninstall --all [--apply --confirm <preview-token>] [--json]
  saber workitem create [JIRA-KEY|descriptive-name] --source-type <chat|jira|document|manual> --source-title <title> --source-file <path> [--source-origin <origin>] [--captured-at <ISO timestamp>] [--source-reference <reference>] [--project <name>] [--json]
  saber workitem status <JIRA-KEY|descriptive-name> [--json]
  saber knowledge validate [--json]
  saber knowledge resolve --repository <name> [--module <name>] [--subject <term>] [--id <knowledge-id>] [--limit <1-20>] [--json]
`;

export type CliDependencies = {
  externalCommand?: ExternalCommandDependencies;
  validateCommand?: ValidateCommandDependencies;
  doctorCommand?: DoctorCommandDependencies;
  statusCommand?: StatusCommandDependencies;
  initCommand?: InitCommandDependencies;
  workitemCommand?: WorkitemCommandDependencies;
  knowledgeCommand?: KnowledgeCommandDependencies;
  actionCommand?: ActionCommandDependencies;
  materializeCommand?: MaterializeCommandDependencies;
  uninstallCommand?: UninstallCommandDependencies;
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

  if (command === "knowledge") {
    return runKnowledgeCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.knowledgeCommand,
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


  if (command === "uninstall") {
    return runUninstallCommand(argv.slice(1), {
      cwd,
      dependencies: dependencies?.uninstallCommand,
    });
  }

  const error = new SaberError(`Unknown command: ${command}`, 2);
  return { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
}
