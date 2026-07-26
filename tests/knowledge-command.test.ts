import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runKnowledgeCommand } from "../src/commands/knowledge.js";
import { createStandardPreset } from "../src/lib/presets.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "saber-knowledge-command-"));
  await mkdir(join(root, "team-contracts"), { recursive: true });
  await mkdir(join(root, "project-knowledge/rules"), { recursive: true });
  await mkdir(join(root, "customer-sources"), { recursive: true });
  await mkdir(join(root, "projects/backend"), { recursive: true });
  await writeFile(join(root, "customer-sources/index.yaml"), "schemaVersion: 1\nsources: []\n", "utf8");
  await writeFile(join(root, "project-knowledge/rules/order.md"), [
    "---", "id: pk-order-cancellation", "layer: project", "kind: business-rule", "assertion: implemented",
    "appliesTo: { repositories: [backend], modules: [order] }", "subjects: [cancellation]",
    "dependsOn: []", "sources: []", "verifiedAt: 2026-07-26", "---", "# 不应出现在命令输出的正文",
  ].join("\n"), "utf8");
  return root;
}

test("knowledge resolve returns paths and reasons without Markdown bodies", async () => {
  const root = await fixture();
  const config = createStandardPreset();
  config.workspace.projects = [{ name: "backend", path: "projects/backend" }];
  try {
    const result = await runKnowledgeCommand([
      "resolve", "--repository", "backend", "--module", "order", "--subject", "cancel", "--json",
    ], { cwd: root, dependencies: { loadConfig: async () => config } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).entries, [{
      id: "pk-order-cancellation", path: "project-knowledge/rules/order.md", reason: "scope-match",
    }]);
    assert.doesNotMatch(result.stdout, /不应出现在命令输出/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
