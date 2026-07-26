import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("release workflow builds native binaries from tags and publishes checksums", async () => {
  const workflow = (await readFile(join(root, ".github/workflows/release.yml"), "utf8")).replace(/\r\n/gu, "\n");
  assert.match(workflow, /tags:\n\s+- 'v\*'/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /node-version: 25/u);
  assert.match(workflow, /darwin-arm64/u);
  assert.doesNotMatch(workflow, /darwin-x64|macos-15-intel/u);
  assert.match(workflow, /linux-x64/u);
  assert.match(workflow, /windows-x64/u);
  assert.match(workflow, /scripts\/smoke-sea\.mjs/u);
  assert.match(workflow, /SABER_RELEASE_TAG/u);
  assert.match(workflow, /refs\/tags\/\$TAG/u);
  assert.match(workflow, /expected=\(/u);
  assert.match(workflow, /publish:[\s\S]*actions\/checkout@v4/u);
  assert.match(workflow, /checksums\.txt/u);
  assert.match(workflow, /contents: write/u);
});
