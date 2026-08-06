import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSaberConfig } from "../src/lib/config.js";

const base = [
  "schemaVersion: 2",
  "projects: []",
  "skills:",
  "  sources:",
  "    - id: mattpocock",
  "      repository: https://github.com/mattpocock/skills",
  "      ref: main",
  "      include:",
  "        - implement",
  "    - id: ponytail",
  "      repository: https://github.com/DietrichGebert/ponytail",
  "      ref: v4.8.4",
  "      include:",
  "        - ponytail-review",
  "loop:",
  "  evidenceBranch: origin/main",
  "  maxIterations: 8",
  "  maxNoProgressIterations: 3",
  "  maxMinutes: 60",
  "",
].join("\n");

test("schema v2 loads multiple skill sources and loop limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-config-"));
  try {
    await writeFile(join(root, "saber.yaml"), base, "utf8");
    const config = await loadSaberConfig(root);
    assert.deepEqual(config.skills.sources.map(({ id, ref }) => ({ id, ref })), [
      { id: "mattpocock", ref: "main" },
      { id: "ponytail", ref: "v4.8.4" },
    ]);
    assert.equal(config.loop.maxNoProgressIterations, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v2 rejects a skill id selected from multiple sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-config-"));
  try {
    await writeFile(join(root, "saber.yaml"), base.replace("        - ponytail-review", "        - implement"), "utf8");
    await assert.rejects(() => loadSaberConfig(root), /skill ids must be unique across sources/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
