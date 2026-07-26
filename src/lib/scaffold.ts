import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ensureBuiltinSkills } from "./builtin-skills.js";
import { readDefaultAsset, type DefaultAssetPath, workspaceDefaultAssetPaths } from "./default-assets.js";
import { SaberError } from "./errors.js";
import { resolveWithinRoot } from "./files.js";

export type ScaffoldResult = { created: string[]; existing: string[] };

const emptyAssets: Readonly<Record<string, string>> = {
  "customer-sources/index.yaml": "schemaVersion: 1\nsources: []\n",
  "project-knowledge/README.md": "# 项目知识\n\n按模块、业务规则、设计、接口、数据模型和依赖拆分知识条目。正文只在当前请求命中时读取。\n",
  "team-contracts/README.md": "# 团队通用契约\n\n这里保存可跨项目复用的工程实践；它不能覆盖项目仓中客户维护的规则。\n",
};

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

async function writeIfMissing(root: string, path: string, content: string, result: ScaffoldResult): Promise<void> {
  const destination = resolveWithinRoot(root, path);
  if (await exists(destination)) { result.existing.push(path); return; }
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(destination, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    result.created.push(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
      result.existing.push(path);
      return;
    }
    throw error;
  }
}

/** Create a minimal team workspace without overwriting any human-maintained content. */
export async function scaffoldWorkspace(root: string): Promise<ScaffoldResult> {
  const result: ScaffoldResult = { created: [], existing: [] };
  try {
    for (const directory of ["projects", "workitems", ".saber"]) await mkdir(resolveWithinRoot(root, directory), { recursive: true });
    for (const path of workspaceDefaultAssetPaths) await writeIfMissing(root, path, await readDefaultAsset(path), result);
    await writeIfMissing(root, ".env", await readDefaultAsset(".env.example"), result);
    await writeIfMissing(root, "saber.local.yaml", await readDefaultAsset("saber.local.example.yaml"), result);
    for (const [path, content] of Object.entries(emptyAssets)) await writeIfMissing(root, path, content, result);
    await ensureBuiltinSkills(root);
    return result;
  } catch (error: unknown) {
    if (error instanceof SaberError) throw error;
    throw new SaberError("could not scaffold the Saber workspace", 1);
  }
}
