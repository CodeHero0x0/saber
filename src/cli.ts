import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SaberError } from "./lib/errors.js";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const usage = `Usage: saber <command>

Commands:
  saber validate
  saber doctor
  saber status
`;

export async function runCli(
  argv: readonly string[],
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<CliResult> {
  void cwd;

  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: usage, stderr: "" };
  }

  if (command === "validate" || command === "doctor" || command === "status") {
    return {
      exitCode: 0,
      stdout: `${command} is not implemented yet\n`,
      stderr: "",
    };
  }

  const error = new SaberError(`Unknown command: ${command}`, 2);
  return { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
}

const entrypoint = process.argv[1];
const isDirectExecution =
  entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint);

if (isDirectExecution) {
  const result = await runCli(process.argv.slice(2));

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
