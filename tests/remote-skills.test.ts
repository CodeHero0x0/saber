import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { syncUpstreamSkills } from "../src/lib/remote-skills.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

test("upstream sync takes only selected skill folders from main", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-upstream-sync-"));
  try {
    const upstream = join(root, "upstream");
    await mkdir(join(upstream, "skills", "productivity", "grill-me"), { recursive: true });
    await mkdir(join(upstream, "skills", "engineering", "tdd"), { recursive: true });
    await writeFile(join(upstream, "skills", "productivity", "grill-me", "SKILL.md"), "# grill\n", "utf8");
    await writeFile(join(upstream, "skills", "engineering", "tdd", "SKILL.md"), "# tdd\n", "utf8");
    await writeFile(join(upstream, "skills", "engineering", "tdd", "reference.md"), "needed asset\n", "utf8");
    await git(upstream, ["init", "--initial-branch", "main"]);
    await git(upstream, ["add", "."]);
    await git(upstream, ["-c", "user.name=Saber Test", "-c", "user.email=saber@example.test", "commit", "-m", "fixture"]);

    const result = await syncUpstreamSkills(root, upstream, ["tdd"]);
    assert.deepEqual(result.skills, ["tdd"]);
    assert.equal(await readFile(join(result.cacheDirectory, "tdd", "SKILL.md"), "utf8"), "# tdd\n");
    assert.equal(await readFile(join(result.cacheDirectory, "tdd", "reference.md"), "utf8"), "needed asset\n");
    await assert.rejects(() => lstat(join(result.cacheDirectory, "grill-me")), { code: "ENOENT" });
    await assert.rejects(() => lstat(join(result.cacheDirectory, ".git")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
