import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMcpEnvironment } from "../src/lib/mcp-environment.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "saber-mcp-environment-"));
}

test("MCP environment loader reads only requested non-empty values", async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, ".env"),
      "MYSQL_HOST=database.internal\nMYSQL_PASSWORD=fixture-password\nJIRA_API_TOKEN=must-not-leak\n",
      "utf8",
    );
    assert.deepEqual(
      await loadMcpEnvironment(root, ["MYSQL_HOST", "MYSQL_PASSWORD"]),
      { MYSQL_HOST: "database.internal", MYSQL_PASSWORD: "fixture-password" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP environment loader rejects missing values without echoing values", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, ".env"), "MYSQL_HOST=database.internal\nMYSQL_PASSWORD=\n", "utf8");
    await assert.rejects(
      () => loadMcpEnvironment(root, ["MYSQL_HOST", "MYSQL_PASSWORD"]),
      (error: unknown) => error instanceof Error
        && /MYSQL_PASSWORD/u.test(error.message)
        && !/database\.internal|fixture-password/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP environment loader rejects a missing or symlinked .env", async () => {
  const root = await fixture();
  const outside = await fixture();
  try {
    await assert.rejects(() => loadMcpEnvironment(root, ["MYSQL_HOST"]), /MCP environment is unavailable/u);
    await writeFile(join(outside, "source.env"), "MYSQL_HOST=database.internal\n", "utf8");
    await symlink(join(outside, "source.env"), join(root, ".env"), "file");
    await assert.rejects(() => loadMcpEnvironment(root, ["MYSQL_HOST"]), /MCP environment is unavailable/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
