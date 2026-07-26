import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const input = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
if (input === undefined) throw new Error("usage: node scripts/smoke-sea.mjs <binary-or-release-directory>");

async function resolveBinary(path) {
  if (!(await stat(path)).isDirectory()) return path;
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const operatingSystem = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const expected = `saber-v${packageJson.version}-${operatingSystem}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  const candidates = await readdir(path, { withFileTypes: true });
  if (!candidates.some((entry) => entry.isFile() && entry.name === expected)) {
    throw new Error(`could not find ${expected} in ${path}`);
  }
  return join(path, expected);
}

const binary = await resolveBinary(input);
const workspace = await mkdtemp(join(tmpdir(), "saber-sea-smoke-"));
try {
  const { stdout } = await run(binary, ["init", "--json"], { cwd: workspace });
  const report = JSON.parse(stdout);
  if (report.ok !== true || report.initializedTool !== null) throw new Error("binary did not scaffold a workspace");
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  for (const path of ["AGENTS.md", "CLAUDE.md", "saber.yaml", ".env", "saber.local.yaml"]) await access(join(workspace, path));
  await access(join(workspace, ".saber", "runtime", "builtin-skills", packageJson.version, "skills", "saber", "SKILL.md"));
  if (!(await readFile(join(workspace, "customer-sources/index.yaml"), "utf8")).includes("sources: []")) throw new Error("binary wrote a non-empty customer source index");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
