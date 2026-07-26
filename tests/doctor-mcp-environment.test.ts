import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectDoctorReport } from "../src/commands/doctor.js";
import { createStandardPreset } from "../src/lib/presets.js";

test("doctor reads MCP readiness from .env without exposing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-doctor-mcp-env-"));
  try {
    await writeFile(join(root, ".env"), "READER_TOKEN=fixture-password\n", "utf8");
    const config = createStandardPreset();
    config.skillSet = { team: [], external: [] };
    config.externalAssets = { schemaVersion: 1, assets: [] };
    config.mcp.servers = [{
      id: "reader",
      transport: "stdio",
      command: "node",
      args: ["reader.js"],
      env: ["READER_TOKEN"],
      tools: [{ name: "read", capability: "jira.read" }],
    }];
    const report = await collectDoctorReport(root, {
      loadConfig: async () => config,
      runner: async () => ({ exitCode: 1 }),
      planExternalAssets: async () => [],
    });

    assert.deepEqual(report.mcp.servers[0]?.environment, {
      declared: ["READER_TOKEN"],
      missing: [],
    });
    assert.doesNotMatch(JSON.stringify(report), /fixture-password/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
