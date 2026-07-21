import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxBinary = join(projectRoot, "node_modules", ".bin", "tsx");

function executeCli(argv: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBinary, ["src/cli.ts", ...argv], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
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
  assert.equal(result.stderr, "Unknown command: unknown");
});

for (const command of ["validate", "doctor", "status"]) {
  test(`runCli returns a placeholder for ${command}`, async () => {
    const result = await runCli([command]);

    assert.deepEqual(result, {
      exitCode: 0,
      stdout: `${command} is not implemented yet\n`,
      stderr: "",
    });
  });
}

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
    stderr: "Unknown command: unknown",
  });
});
