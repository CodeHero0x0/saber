import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

function releasePlatform() {
  const operatingSystem = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  if (operatingSystem === undefined || !["arm64", "x64"].includes(process.arch)) {
    throw new Error(`unsupported release builder platform: ${process.platform}-${process.arch}`);
  }
  return `${operatingSystem}-${process.arch}`;
}

function assertSeaRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 25 || (major === 25 && minor < 5)) {
    throw new Error("building a Saber release binary requires Node.js 25.5 or newer with --build-sea");
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main() {
  assertSeaRuntime();
  const target = process.env.SABER_RELEASE_TARGET ?? releasePlatform();
  if (target !== releasePlatform()) throw new Error("SABER_RELEASE_TARGET must match the native builder platform");

  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string") throw new Error("package.json version is invalid");
  const releaseTag = process.env.SABER_RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${packageJson.version}`) {
    throw new Error(`SABER_RELEASE_TAG (${releaseTag}) must equal package.json version (v${packageJson.version})`);
  }

  const extension = process.platform === "win32" ? ".exe" : "";
  const buildDirectory = join(repositoryRoot, "build", "sea");
  const releaseDirectory = join(repositoryRoot, "release");
  const bundledCli = join(buildDirectory, "cli.cjs");
  const output = join(releaseDirectory, `saber-v${packageJson.version}-${target}${extension}`);

  await rm(buildDirectory, { recursive: true, force: true });
  await mkdir(buildDirectory, { recursive: true });
  await mkdir(releaseDirectory, { recursive: true });
  await rm(output, { force: true });
  await rm(`${output}.sha256`, { force: true });

  await build({
    entryPoints: [join(repositoryRoot, "src", "sea-entry.ts")],
    outfile: bundledCli,
    bundle: true,
    format: "cjs",
    platform: "node",
    mainFields: ["module", "main"],
    target: "node20",
    sourcemap: false,
    logLevel: "info",
  });

  const configPath = join(buildDirectory, "sea-config.json");
  await writeFile(configPath, `${JSON.stringify({ main: bundledCli, output, disableExperimentalSEAWarning: true }, null, 2)}\n`, "utf8");
  const result = spawnSync(process.execPath, ["--build-sea", configPath], { cwd: repositoryRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Node SEA build failed");

  if (process.platform === "darwin") {
    const signing = spawnSync("codesign", ["--force", "--sign", "-", output], { cwd: repositoryRoot, stdio: "inherit" });
    if (signing.status !== 0) throw new Error("macOS ad-hoc signing failed");
  }

  await writeFile(`${output}.sha256`, `${await sha256(output)}  ${basename(output)}\n`, "utf8");
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "binary build failed"}\n`);
  process.exitCode = 1;
});
