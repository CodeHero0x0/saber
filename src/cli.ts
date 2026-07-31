import { runSetupCommand, type SetupCommandDependencies } from "./commands/setup.js";
import { SaberError } from "./lib/errors.js";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const usage = "Usage: saber setup\n";

export type CliDependencies = {
  setupCommand?: SetupCommandDependencies;
};

export async function runCli(
  argv: readonly string[],
  { cwd = process.cwd(), dependencies }: { cwd?: string; dependencies?: CliDependencies } = {},
): Promise<CliResult> {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: usage, stderr: "" };
  }
  if (command === "setup") return runSetupCommand(argv.slice(1), { cwd, dependencies: dependencies?.setupCommand });
  const error = new SaberError(`Unknown command: ${command}`, 2);
  return { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
}
