import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdownFrontMatter } from "../src/lib/frontmatter.js";
import { formatSchemaIssues, workitemFrontMatterSchema } from "../src/lib/schemas.js";

test("parses one YAML front matter block and preserves the Markdown body", () => {
  const parsed = parseMarkdownFrontMatter("---\nid: PROJ-123\n---\n# 需求\n正文\n");

  assert.deepEqual(parsed.attributes, { id: "PROJ-123" });
  assert.equal(parsed.body, "# 需求\n正文\n");
});

test("reports a field path when workflow control fields are present", () => {
  const result = workitemFrontMatterSchema.safeParse({
    schemaVersion: 1,
    id: "PROJ-123",
    title: "标题",
    source: { kind: "manual", capturedAt: "2026-07-26T00:00:00.000Z" },
    stage: "dev",
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(formatSchemaIssues(result.error).join("\n"), /stage/u);
  }
});

test("requires a knowledge impact conclusion in every workitem front matter", () => {
  const result = workitemFrontMatterSchema.safeParse({
    schemaVersion: 1,
    id: "PROJ-123",
    title: "标题",
    source: { kind: "manual", capturedAt: "2026-07-26T00:00:00.000Z" },
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(formatSchemaIssues(result.error).join("\n"), /knowledgeImpact/u);
  }
});
