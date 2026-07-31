import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const input = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
if (input === undefined) throw new Error("usage: node scripts/smoke-sea.mjs <binary-or-release-directory>");

async function resolveBinary(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return path;
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const operatingSystem = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const expected = `saber-v${packageJson.version}-${operatingSystem}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  if (!entries.some((entry) => entry.isFile() && entry.name === expected)) {
    throw new Error(`could not find ${expected} in ${path}`);
  }
  return join(path, expected);
}

const binary = await resolveBinary(input);
const workspace = await mkdtemp(join(tmpdir(), "saber-sea-smoke-"));
try {
  await cp(join(repositoryRoot, "saber.yaml"), join(workspace, "saber.yaml"));
  await cp(join(repositoryRoot, "skills"), join(workspace, "skills"), { recursive: true });
  const project = join(workspace, "projects", "frontend");
  await mkdir(join(project, ".agents", "skills"), { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: project });

  const { stdout } = await run(binary, ["setup"], { cwd: workspace });
  assert.match(stdout, /Saber setup complete/u);
  assert.match(stdout, /frontend: 13 managed links/u);
  await access(join(workspace, ".saber", "managed", "manifest.json"));
  assert.ok((await lstat(join(project, ".agents", "skills", "grill-me"))).isSymbolicLink());
  assert.ok((await lstat(join(project, ".agents", "skills", "team-knowledge"))).isSymbolicLink());
  assert.ok((await lstat(join(project, ".agents", "skills", "promote"))).isSymbolicLink());
} finally {
  await rm(workspace, { recursive: true, force: true });
}

process.stdout.write(`smoke-tested ${binary}\n`);
