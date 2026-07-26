import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const runtimeAssets = [
  ".env.example", ".gitignore", "AGENTS.md", "CLAUDE.md", "saber.local.example.yaml", "saber.yaml",
  "templates/workitem/workitem.md",
  "skills/grill-me/SKILL.md", "skills/grill-with-docs/SKILL.md", "skills/openspec/SKILL.md",
  "skills/saber/SKILL.md", "skills/saber-grill/SKILL.md", "skills/saber-grill-with-docs/SKILL.md",
  "skills/saber-openspec/SKILL.md", "skills/saber-superpower/SKILL.md", "skills/superpowers/SKILL.md",
];

const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "saber-npm-package-"));
let tarball;

try {
  const { stdout } = await run(npm, ["pack", "--json", "--ignore-scripts"], { cwd: repositoryRoot });
  const packed = JSON.parse(stdout);
  assert.equal(Array.isArray(packed), true, "npm pack did not return a package list");
  assert.equal(packed.length, 1, "npm pack must produce exactly one tarball");
  assert.equal(typeof packed[0]?.filename, "string", "npm pack did not return a tarball filename");
  tarball = join(repositoryRoot, packed[0].filename);
  const included = new Set(packed[0].files.map((file) => file.path));
  const packagedRuntimeAssets = runtimeAssets.map((path) => path === ".gitignore" ? "templates/default.gitignore" : path);
  for (const path of ["dist/main.js", "LICENSE", "README.md", ...packagedRuntimeAssets]) {
    assert.equal(included.has(path), true, `npm package is missing ${path}`);
  }
  for (const path of ["src/main.ts", "tests/workitems.test.ts", ".env", "saber.local.yaml", "projects"]) {
    assert.equal(included.has(path), false, `npm package must not include ${path}`);
  }

  const installationRoot = join(temporaryRoot, "installation");
  const workspace = join(temporaryRoot, "workspace");
  await mkdir(installationRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await run(npm, ["install", "--ignore-scripts", tarball], { cwd: installationRoot });
  const executable = join(installationRoot, "node_modules", "@codehero0x0", "saber", "dist", "main.js");
  const { stdout: initOutput } = await run(process.execPath, [executable, "init", "--json"], { cwd: workspace });
  const report = JSON.parse(initOutput);
  assert.equal(report.ok, true, "installed npm package could not initialize a workspace");
  for (const path of runtimeAssets) await access(join(workspace, path));
} finally {
  if (tarball !== undefined) await rm(tarball, { force: true });
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`verified @codehero0x0/saber@${packageJson.version} package contents and installation\n`);
