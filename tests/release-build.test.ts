import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultAssetPaths } from "../src/lib/default-assets.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("SEA release asset allowlist exists and build script uses every asset", async () => {
  const script = await readFile(join(root, "scripts/build-sea.mjs"), "utf8");
  for (const path of defaultAssetPaths) {
    await access(join(root, path));
    assert.match(script, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(script, /--build-sea/u);
  assert.match(script, /SABER_RELEASE_TARGET/u);
  assert.match(script, /SABER_RELEASE_TAG/u);
  assert.match(script, /basename\(output\)/u);
});
