import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("release keeps native artifacts and OIDC-only npm publishing", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");

  assert.equal(packageJson.scripts?.["build:binary"], "node scripts/build-sea.mjs");
  assert.equal(packageJson.scripts?.["smoke:binary"], "node scripts/smoke-sea.mjs");
  assert.match(workflow, /target: darwin-arm64/u);
  assert.match(workflow, /target: linux-x64/u);
  assert.match(workflow, /target: windows-x64/u);
  assert.match(workflow, /node-version: 25/u);
  assert.match(workflow, /node-version: 24/u);
  assert.match(workflow, /gh release upload/u);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/u);
});
