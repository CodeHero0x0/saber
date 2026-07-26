import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkKnowledgeSources, resolveKnowledge, validateKnowledgeAssets } from "../src/lib/knowledge.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "saber-knowledge-"));
  await mkdir(join(root, "team-contracts"), { recursive: true });
  await mkdir(join(root, "project-knowledge/rules"), { recursive: true });
  await mkdir(join(root, "customer-sources"), { recursive: true });
  await writeFile(join(root, "customer-sources/index.yaml"), "schemaVersion: 1\nsources: []\n", "utf8");
  return root;
}

test("catalog reads metadata and rejects a missing dependency", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "project-knowledge/rules/cancellation.md"), [
      "---",
      "id: pk-cancellation",
      "layer: project",
      "kind: business-rule",
      "assertion: implemented",
      "appliesTo: { repositories: [backend], modules: [order] }",
      "subjects: [cancellation]",
      "dependsOn: [pk-missing]",
      "sources: []",
      "verifiedAt: 2026-07-26",
      "---",
      "# 只应在选择后读取的正文",
      "",
    ].join("\n"), "utf8");

    const errors = await validateKnowledgeAssets(root);
    assert.deepEqual(errors, ["project-knowledge/rules/cancellation.md depends on missing knowledge entry pk-missing"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve selects direct matches then at most one dependency hop within its limit", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "project-knowledge/rules/order.md"), [
      "---", "id: pk-order-cancellation", "layer: project", "kind: business-rule", "assertion: implemented",
      "appliesTo: { repositories: [backend], modules: [order] }", "subjects: [cancellation]",
      "dependsOn: [pk-refund-api]", "sources: []", "verifiedAt: 2026-07-26", "---", "# 订单取消",
    ].join("\n"), "utf8");
    await writeFile(join(root, "project-knowledge/rules/refund.md"), [
      "---", "id: pk-refund-api", "layer: project", "kind: interface", "assertion: implemented",
      "appliesTo: { repositories: [backend], modules: [refund] }", "subjects: [refund]",
      "dependsOn: []", "sources: []", "verifiedAt: 2026-07-26", "---", "# 退款接口",
    ].join("\n"), "utf8");
    await writeFile(join(root, "project-knowledge/rules/unrelated.md"), [
      "---", "id: pk-unrelated", "layer: project", "kind: design", "assertion: implemented",
      "appliesTo: { repositories: [frontend], modules: [profile] }", "subjects: [avatar]",
      "dependsOn: []", "sources: []", "verifiedAt: 2026-07-26", "---", "# 头像",
    ].join("\n"), "utf8");

    const result = await resolveKnowledge(root, {
      repositories: ["backend"], modules: ["order"], subjects: ["cancel"], ids: [], limit: 2, repositoryPaths: [],
    });
    assert.deepEqual(result.entries.map((entry) => entry.id), ["pk-order-cancellation", "pk-refund-api"]);
    assert.equal(result.entries.some((entry) => entry.id === "pk-unrelated"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source changes after the recorded revision produce a possible-stale risk", async () => {
  const root = await fixture();
  try {
    const risks = await checkKnowledgeSources(root, [{
      id: "pk-order-cancellation", path: "project-knowledge/rules/order.md", layer: "project", kind: "business-rule", assertion: "implemented",
      appliesTo: { repositories: ["backend"], modules: ["order"] }, subjects: ["cancellation"], dependsOn: [],
      sources: [{ repository: "backend", path: "src/order.ts", revision: "3f2c1a7" }], verifiedAt: "2026-07-26",
    }], [{ id: "backend", path: "projects/backend" }], async (command) => ({
      exitCode: command.args.includes("diff") ? 1 : 0,
    }));
    assert.deepEqual(risks, [{ code: "possible-stale", entryId: "pk-order-cancellation", source: "backend:src/order.ts" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local staged source changes produce a possible-stale risk", async () => {
  const root = await fixture();
  try {
    const risks = await checkKnowledgeSources(root, [{
      id: "pk-order-cancellation", path: "project-knowledge/rules/order.md", layer: "project", kind: "business-rule", assertion: "implemented",
      appliesTo: { repositories: ["backend"], modules: ["order"] }, subjects: ["cancellation"], dependsOn: [],
      sources: [{ repository: "backend", path: "src/order.ts", revision: "3f2c1a7" }], verifiedAt: "2026-07-26",
    }], [{ id: "backend", path: "projects/backend" }], async (command) => ({
      exitCode: command.args.includes("--cached") ? 1 : 0,
    }));
    assert.deepEqual(risks, [{ code: "possible-stale", entryId: "pk-order-cancellation", source: "backend:src/order.ts" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local unstaged source changes produce a possible-stale risk", async () => {
  const root = await fixture();
  try {
    const risks = await checkKnowledgeSources(root, [{
      id: "pk-order-cancellation", path: "project-knowledge/rules/order.md", layer: "project", kind: "business-rule", assertion: "implemented",
      appliesTo: { repositories: ["backend"], modules: ["order"] }, subjects: ["cancellation"], dependsOn: [],
      sources: [{ repository: "backend", path: "src/order.ts", revision: "3f2c1a7" }], verifiedAt: "2026-07-26",
    }], [{ id: "backend", path: "projects/backend" }], async (command) => ({
      exitCode: command.args[0] === "diff" && !command.args.some((argument) => argument.includes("..HEAD")) && !command.args.includes("--cached") ? 1 : 0,
    }));
    assert.deepEqual(risks, [{ code: "possible-stale", entryId: "pk-order-cancellation", source: "backend:src/order.ts" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve includes relevant team contracts and filters customer rules to the requested module", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "team-contracts/cancellation.md"), [
      "---", "id: tc-cancellation-quality", "layer: team", "kind: quality-rule", "subjects: [cancellation]", "verifiedAt: 2026-07-26", "---", "# 团队质量规则",
    ].join("\n"), "utf8");
    await writeFile(join(root, "project-knowledge/rules/order.md"), [
      "---", "id: pk-order-cancellation", "layer: project", "kind: business-rule", "assertion: implemented",
      "appliesTo: { repositories: [backend], modules: [order] }", "subjects: [cancellation]", "dependsOn: []", "sources: []", "verifiedAt: 2026-07-26", "---", "# 订单取消",
    ].join("\n"), "utf8");
    await writeFile(join(root, "customer-sources/index.yaml"), [
      "schemaVersion: 1", "sources:", "  - repository: backend", "    path: AGENTS.md", "    appliesTo: { repositories: [backend], modules: [order] }", "    revision: 3f2c1a7",
      "  - repository: backend", "    path: payroll.md", "    appliesTo: { repositories: [backend], modules: [payroll] }", "    revision: 3f2c1a7",
    ].join("\n"), "utf8");
    const result = await resolveKnowledge(root, {
      repositories: ["backend"], modules: ["order"], subjects: ["cancel"], ids: [], limit: 3,
      repositoryPaths: [{ id: "backend", path: "projects/backend" }],
    }, async () => ({ exitCode: 0 }));
    assert.deepEqual(result.entries.map((entry) => entry.id), ["pk-order-cancellation", "tc-cancellation-quality"]);
    assert.deepEqual(result.customerSources, [{ repository: "backend", path: "AGENTS.md", reason: "module-scope" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve marks a selected customer rule stale when its recorded revision differs", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "customer-sources/index.yaml"), [
      "schemaVersion: 1", "sources:", "  - repository: backend", "    path: AGENTS.md", "    appliesTo: { repositories: [backend], modules: [order] }", "    revision: 3f2c1a7",
    ].join("\n"), "utf8");
    const result = await resolveKnowledge(root, {
      repositories: ["backend"], modules: ["order"], subjects: [], ids: [], limit: 3,
      repositoryPaths: [{ id: "backend", path: "projects/backend" }],
    }, async (command) => ({ exitCode: command.args.includes("diff") ? 1 : 0 }));
    assert.deepEqual(result.risks, [{ code: "possible-stale", entryId: "customer-rule:backend:AGENTS.md", source: "backend:AGENTS.md" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve applies the total limit to customer rules before selecting project knowledge", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "customer-sources/index.yaml"), [
      "schemaVersion: 1", "sources:", "  - repository: backend", "    path: AGENTS.md", "    appliesTo: { repositories: [backend], modules: [order] }", "    revision: 3f2c1a7",
      "  - repository: backend", "    path: customer-rules.md", "    appliesTo: { repositories: [backend], modules: [order] }", "    revision: 3f2c1a7",
    ].join("\n"), "utf8");
    const result = await resolveKnowledge(root, {
      repositories: ["backend"], modules: ["order"], subjects: [], ids: [], limit: 1,
      repositoryPaths: [{ id: "backend", path: "projects/backend" }],
    }, async () => ({ exitCode: 0 }));
    assert.deepEqual(result.customerSources, [{ repository: "backend", path: "AGENTS.md", reason: "module-scope" }]);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.uncovered, ["customer-rule:backend:customer-rules.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
