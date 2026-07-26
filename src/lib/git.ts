import { spawn } from "node:child_process";
import { devNull } from "node:os";

/** A shell-free process request. Callers pass data as argv, never a command string. */
export type SafeProcessCommand = {
  program: string;
  args: readonly string[];
  cwd?: string;
  /** Output is opt-in so ordinary Git reads cannot accidentally retain large logs. */
  captureStdout?: boolean;
  captureStderr?: boolean;
};

/** Process failures are represented as data so diagnostics can continue independently. */
export type SafeProcessResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  error?: "could-not-start";
  outputTruncated?: boolean;
};

/** Injectable boundary for commands that need local process information. */
export type SafeProcessRunner = (command: SafeProcessCommand) => Promise<SafeProcessResult>;

const maximumCapturedOutputBytes = 16 * 1024;

type OutputCollector = {
  append(chunk: Buffer): void;
  text(): string;
  readonly truncated: boolean;
};

function createOutputCollector(): OutputCollector {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  let truncated = false;

  return {
    append(chunk: Buffer): void {
      const remaining = maximumCapturedOutputBytes - byteCount;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      const retained = chunk.subarray(0, remaining);
      chunks.push(Buffer.from(retained));
      byteCount += retained.length;
      if (chunk.length > remaining) {
        truncated = true;
      }
    },
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated(): boolean {
      return truncated;
    },
  };
}

/**
 * Run a local program without a shell and with bounded optional output.
 * `could-not-start` intentionally carries no OS error text because that text
 * can contain user-local paths and configuration details.
 */
export async function runSafeProcess(
  command: SafeProcessCommand,
): Promise<SafeProcessResult> {
  return new Promise((resolve) => {
    const captureStdout = command.captureStdout === true;
    const captureStderr = command.captureStderr === true;
    const stdout = createOutputCollector();
    const stderr = createOutputCollector();
    let settled = false;

    const finish = (result: SafeProcessResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child;
    try {
      child = spawn(command.program, command.args, {
        cwd: command.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", captureStdout ? "pipe" : "ignore", captureStderr ? "pipe" : "ignore"],
      });
    } catch {
      finish({ exitCode: 127, error: "could-not-start" });
      return;
    }

    if (captureStdout && child.stdout !== null) {
      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    }
    if (captureStderr && child.stderr !== null) {
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    }

    child.once("error", () => finish({ exitCode: 127, error: "could-not-start" }));
    child.once("close", (code) => {
      const outputTruncated = stdout.truncated || stderr.truncated;
      finish({
        exitCode: outputTruncated ? 1 : (code ?? 1),
        ...(captureStdout ? { stdout: stdout.text() } : {}),
        ...(captureStderr ? { stderr: stderr.text() } : {}),
        ...(outputTruncated ? { outputTruncated: true } : {}),
      });
    });
  });
}

/** Build a read-oriented Git command with bounded stdout capture. */
export function gitCommand(
  args: readonly string[],
  cwd?: string,
): SafeProcessCommand {
  return { program: "git", args, ...(cwd === undefined ? {} : { cwd }), captureStdout: true };
}

/** Git clone runs with repository hooks disabled and never through a shell. */
export function gitCloneCommand(
  source: string,
  destination: string,
): SafeProcessCommand {
  return {
    program: "git",
    args: [
      "-c",
      `core.hooksPath=${devNull}`,
      "clone",
      "--",
      source,
      destination,
    ],
  };
}

/** Only keep a concise printable first line for diagnostics and JSON reports. */
export function safeVersionLine(output: string | undefined): string | undefined {
  if (output === undefined) {
    return undefined;
  }

  const firstLine = output.split(/\r?\n/u, 1)[0]?.trim();
  if (
    firstLine === undefined ||
    firstLine.length === 0 ||
    firstLine.length > 256 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(firstLine)
  ) {
    return undefined;
  }

  return firstLine;
}
