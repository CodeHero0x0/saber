import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import type { UpstreamSkillSynchronizer } from "../src/lib/remote-skills.js";

const defaultSkills = [
  "grill-me", "grilling", "tdd", "grill-with-docs", "to-spec", "to-tickets",
  "implement", "domain-modeling", "code-review",
];

async function writeSkill(root: string, id: string): Promise<void> {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, "SKILL.md"), `---\nname: ${id}\n---\n# ${id}\n`, "utf8");
}

async function writeConfig(root: string, include = defaultSkills, projects = ["frontend", "backend"]): Promise<void> {
  const projectLines = projects.flatMap((name) => [`  - name: ${name}`, `    path: projects/${name}`]);
  const skillLines = include.map((id) => `    - ${id}`);
  await writeFile(join(root, "saber.yaml"), [
    "schemaVersion: 1", "projects:", ...projectLines, "skills:",
    "  source: https://github.com/mattpocock/skills", "  include:", ...skillLines, "",
  ].join("\n"), "utf8");
}

function fixtureSync(upstream: string): UpstreamSkillSynchronizer {
  return async (root, _source, ids) => {
    const cache = join(root, ".saber", "managed", "skills");
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    for (const id of ids) await cp(join(upstream, id), join(cache, id), { recursive: true });
    return { cacheDirectory: cache, skills: [...ids] };
  };
}

async function createProject(root: string, name: string, tools: string[]): Promise<string> {
  const project = join(root, "projects", name);
  await mkdir(join(project, ".git", "info"), { recursive: true });
  for (const tool of tools) await mkdir(join(project, tool), { recursive: true });
  return project;
}

test("setup projects only selected skills, preserves conflicts, and cleans removed skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-vnext-setup-"));
  try {
    const upstream = join(root, "fixture-upstream");
    for (const id of defaultSkills) await writeSkill(upstream, id);
    await writeSkill(join(root, "skills"), "team-knowledge");
    await writeSkill(join(root, "skills"), "promote");
    await writeConfig(root);

    const frontend = await createProject(root, "frontend", [".agents/skills", ".claude/skills"]);
    const backend = await createProject(root, "backend", [".opencode/skills"]);
    await mkdir(join(frontend, ".agents", "skills", "tdd"), { recursive: true });
    await writeFile(join(frontend, ".agents", "skills", "tdd", "SKILL.md"), "# personal tdd\n", "utf8");
    await mkdir(join(frontend, "personal-code-review"), { recursive: true });
    await symlink("../../personal-code-review", join(frontend, ".agents", "skills", "code-review"), "dir");
    await writeFile(join(backend, "CONTEXT.md"), "# Existing context\n", "utf8");

    const dependencies = { setupCommand: { syncSkills: fixtureSync(upstream) } };
    const first = await runCli(["setup"], { cwd: root, dependencies });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /conflict preserved: \.agents\/skills\/tdd/u);
    assert.match(first.stdout, /frontend: /u);
    assert.match(first.stdout, /backend: /u);

    const managedGrill = join(frontend, ".agents", "skills", "grill-me");
    assert.ok((await lstat(managedGrill)).isSymbolicLink());
    assert.equal(await realpath(managedGrill), await realpath(join(root, ".saber", "managed", "skills", "grill-me")));
    assert.equal(await realpath(join(frontend, ".agents", "skills", "team-knowledge")), await realpath(join(root, "skills", "team-knowledge")));
    assert.equal(await readFile(join(frontend, ".agents", "skills", "tdd", "SKILL.md"), "utf8"), "# personal tdd\n");
    assert.equal(await readlink(join(frontend, ".agents", "skills", "code-review")), "../../personal-code-review");
    assert.ok((await lstat(join(frontend, "CONTEXT.md"))).isSymbolicLink());
    assert.ok((await lstat(join(frontend, "docs", "adr"))).isSymbolicLink());
    assert.ok((await lstat(join(frontend, ".saber", "work", "features"))).isDirectory());
    assert.equal(await readFile(join(backend, "CONTEXT.md"), "utf8"), "# Existing context\n");
    assert.ok((await lstat(join(backend, "docs", "adr"))).isSymbolicLink());

    const excludes = await readFile(join(frontend, ".git", "info", "exclude"), "utf8");
    assert.match(excludes, /\/\.agents\/skills\/grill-me/u);
    assert.match(excludes, /\/CONTEXT\.md/u);
    assert.doesNotMatch(excludes, /\/\.agents\/skills\/\n/u);

    await writeConfig(root, ["grill-me"]);
    const second = await runCli(["setup"], { cwd: root, dependencies });
    assert.equal(second.exitCode, 0, second.stderr);
    await assert.rejects(() => lstat(join(frontend, ".agents", "skills", "grilling")), { code: "ENOENT" });
    await assert.rejects(() => lstat(join(root, ".saber", "managed", "skills", "grilling")), { code: "ENOENT" });
    assert.equal(await readFile(join(frontend, ".agents", "skills", "tdd", "SKILL.md"), "utf8"), "# personal tdd\n");
    assert.ok((await lstat(join(frontend, ".agents", "skills", "promote"))).isSymbolicLink());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup skips absent configured projects and only runs at a Saber root", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-vnext-root-"));
  try {
    const upstream = join(root, "fixture-upstream");
    await writeSkill(upstream, "grill-me");
    await writeSkill(join(root, "skills"), "team-knowledge");
    await writeSkill(join(root, "skills"), "promote");
    await writeConfig(root, ["grill-me"], ["frontend", "missing"]);
    const frontend = await createProject(root, "frontend", [".agents/skills"]);
    const dependencies = { setupCommand: { syncSkills: fixtureSync(upstream) } };

    const result = await runCli(["setup"], { cwd: root, dependencies });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /missing: skipped \(project directory is absent\)/u);

    const notRoot = await runCli(["setup"], { cwd: frontend, dependencies });
    assert.equal(notRoot.exitCode, 2);
    assert.match(notRoot.stderr, /Saber root/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
