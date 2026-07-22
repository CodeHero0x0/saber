import { SaberError } from "../lib/errors.js";
import { runMcpBridge, type RunMcpBridgeOptions } from "../lib/mcp/bridge.js";

export type McpCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type McpCommandDependencies = {
  runBridge?: (options: RunMcpBridgeOptions) => Promise<void>;
};

function parseBridgeArguments(argv: readonly string[]): string {
  if (argv[0] !== "bridge") {
    throw new SaberError("mcp command requires bridge", 2);
  }
  let descriptorPath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--descriptor") {
      throw new SaberError("unknown flag", 2);
    }
    if (descriptorPath !== undefined) {
      throw new SaberError("duplicate flag --descriptor", 2);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new SaberError("--descriptor requires a value", 2);
    }
    descriptorPath = value;
    index += 1;
  }
  if (descriptorPath === undefined) {
    throw new SaberError("--descriptor is required", 2);
  }
  return descriptorPath;
}

/** Internal MCP entry point; the repository CLI wires it separately. */
export async function runMcpCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: McpCommandDependencies },
): Promise<McpCommandResult> {
  try {
    const descriptorPath = parseBridgeArguments(argv);
    await (dependencies.runBridge ?? runMcpBridge)({
      repositoryRoot: cwd,
      descriptorPath,
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (error: unknown) {
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    const message = error instanceof SaberError ? error.message : "mcp command failed";
    return { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
