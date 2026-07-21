import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxBinary = join(projectRoot, "node_modules", ".bin", "tsx");
const tscBinary = join(projectRoot, "node_modules", ".bin", "tsc");

function executeProcess(
  executable: string,
  argv: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, argv, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let completed = false;

    const complete = (result: ProcessResult): void => {
      if (!completed) {
        completed = true;
        resolve(result);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      complete({
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: error.message,
      });
    });
    child.on("close", (code) => {
      complete({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

function executeTsx(argv: readonly string[]): Promise<ProcessResult> {
  return executeProcess(tsxBinary, argv);
}

function executeCli(argv: readonly string[]): Promise<ProcessResult> {
  return executeTsx(["src/cli.ts", ...argv]);
}

test("runCli shows help when no command is supplied", async () => {
  const result = await runCli([], { cwd: process.cwd() });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /saber validate/);
  assert.equal(result.stderr, "");
});

test("runCli shows help for both help flags", async () => {
  for (const argument of ["--help", "-h"]) {
    const result = await runCli([argument]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /saber validate/);
    assert.equal(result.stderr, "");
  }
});

test("runCli rejects an unknown command", async () => {
  const result = await runCli(["unknown"]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Unknown command: unknown\n");
});

test("direct CLI execution writes a parseable validate JSON report", async () => {
  const result = await executeCli(["validate", "--json"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, errors: [] });
});

test("importing the CLI module does not write output or change process.exitCode", async () => {
  const result = await executeTsx([
    "--eval",
    'process.exitCode = 17; import("./src/cli.ts").then(() => process.stdout.write(String(process.exitCode)));',
  ]);

  assert.deepEqual(result, {
    exitCode: 17,
    stdout: "17",
    stderr: "",
  });
});

test("direct CLI execution writes help to stdout", async () => {
  const result = await executeCli([]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /saber validate/);
  assert.equal(result.stderr, "");
});

test("direct CLI execution writes an unknown-command error only to stderr", async () => {
  const result = await executeCli(["unknown"]);

  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "",
    stderr: "Unknown command: unknown\n",
  });
});

test("packaged CLI executes through an npm-style symlink", async () => {
  const build = await executeProcess(tscBinary, ["-p", "tsconfig.json"]);
  assert.deepEqual(build, { exitCode: 0, stdout: "", stderr: "" });

  const distCli = join(projectRoot, "dist", "cli.js");
  const originalMode = (await stat(distCli)).mode & 0o777;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "saber-bin-"));
  const executableLink = join(temporaryDirectory, "saber");

  try {
    await chmod(distCli, 0o755);
    await symlink(
      relative(await realpath(temporaryDirectory), await realpath(distCli)),
      executableLink,
    );

    const validate = await executeProcess(executableLink, ["validate", "--json"]);
    assert.equal(validate.exitCode, 0);
    assert.equal(validate.stderr, "");
    assert.deepEqual(JSON.parse(validate.stdout), { valid: true, errors: [] });

    const unknown = await executeProcess(executableLink, ["unknown"]);
    assert.deepEqual(unknown, {
      exitCode: 2,
      stdout: "",
      stderr: "Unknown command: unknown\n",
    });
  } finally {
    await chmod(distCli, originalMode);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
