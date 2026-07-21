import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { parseBooleanArguments } from "../lib/argv.js";
import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import {
  readTextWithinRoot,
  resolveExistingPathWithinRoot,
  resolveWithinRoot,
} from "../lib/files.js";
import type { RepositoryConfig } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";

export type ValidationReport = {
  valid: boolean;
  errors: string[];
};

export type ValidateCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ValidateCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
  validateAssets?: (repositoryRoot: string) => Promise<string[]>;
};

type AssetDirectory = "roles" | "workflows" | "skills";

const requiredRoleFiles = ["ba.md", "dev.md", "qa.md"] as const;
const requiredWorkflowPackages = ["requirements", "develop", "test", "fix"] as const;
const requiredSkillPackages = [
  "grill-me",
  "grill-with-docs",
  "superpowers",
  "openspec",
] as const;
const requiredWorkflowPackageNames: readonly string[] = requiredWorkflowPackages;
const requiredSkillPackageNames: readonly string[] = requiredSkillPackages;

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof SaberError) {
    return error.message;
  }

  return "could not read Saber configuration";
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

function isSafeRelativeAssetPath(relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    return false;
  }

  return relativePath
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "..");
}

/** Detect a link before resolving it; a link within root is still not a checked-in asset. */
async function hasSymbolicLinkComponent(
  repositoryRoot: string,
  relativePath: string,
): Promise<boolean> {
  let currentPath = resolve(repositoryRoot);
  for (const segment of relativePath.split("/")) {
    currentPath = join(currentPath, segment);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        return true;
      }
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        return false;
      }
      throw error;
    }
  }
  return false;
}

async function isRegularFileWithinRoot(
  repositoryRoot: string,
  relativePath: string,
): Promise<boolean> {
  if (!isSafeRelativeAssetPath(relativePath)) {
    return false;
  }
  if (await hasSymbolicLinkComponent(repositoryRoot, relativePath)) {
    return false;
  }

  try {
    const filePath = await resolveExistingPathWithinRoot(repositoryRoot, relativePath);
    return (await lstat(filePath)).isFile();
  } catch (error: unknown) {
    if (isMissingPath(error) || error instanceof SaberError) {
      return false;
    }
    throw error;
  }
}

async function listAssetDirectory(
  repositoryRoot: string,
  directory: AssetDirectory,
  errors: string[],
): Promise<Dirent<string>[] | undefined> {
  try {
    if (await hasSymbolicLinkComponent(repositoryRoot, directory)) {
      errors.push(`${directory} must not contain a symbolic link`);
      return undefined;
    }
    const path = await resolveExistingPathWithinRoot(repositoryRoot, directory);
    const status = await lstat(path);
    if (!status.isDirectory()) {
      errors.push(`${directory} must be a directory`);
      return undefined;
    }
    return await readdir(path, { withFileTypes: true, encoding: "utf8" });
  } catch (error: unknown) {
    if (isMissingPath(error) || error instanceof SaberError) {
      errors.push(`missing asset directory ${directory}`);
      return undefined;
    }
    errors.push(`could not inspect asset directory ${directory}`);
    return undefined;
  }
}

function localMarkdownLinks(content: string): string[] {
  const links: string[] = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1]?.trim();
    if (rawTarget === undefined || rawTarget.length === 0 || rawTarget.startsWith("#")) {
      continue;
    }
    // URLs and mailto links are not checked-in support artifacts. Any local
    // destination must be relative and is checked below.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget) || rawTarget.startsWith("//")) {
      continue;
    }
    const target = rawTarget.split(/[?#]/u, 1)[0];
    if (target !== undefined && target.length > 0) {
      links.push(target);
    }
  }
  return links;
}

async function validateMarkdownReferences(
  repositoryRoot: string,
  filePath: string,
  packageRoot: string,
  errors: string[],
): Promise<void> {
  let content: string;
  try {
    content = await readTextWithinRoot(repositoryRoot, filePath);
  } catch {
    errors.push(`could not read asset ${filePath}`);
    return;
  }

  for (const target of localMarkdownLinks(content)) {
    if (!isSafeRelativeAssetPath(target)) {
      errors.push(`${filePath} references an unsafe local support artifact`);
      continue;
    }

    const linkedPath = join(dirname(filePath), target).replaceAll("\\", "/");
    const pathFromPackage = relative(packageRoot, linkedPath).replaceAll("\\", "/");
    if (
      pathFromPackage === ".." ||
      pathFromPackage.startsWith("../") ||
      pathFromPackage.length === 0 ||
      !isSafeRelativeAssetPath(pathFromPackage)
    ) {
      errors.push(`${filePath} references an unsafe local support artifact`);
      continue;
    }

    if (!(await isRegularFileWithinRoot(repositoryRoot, linkedPath))) {
      errors.push(`${filePath} references a missing local support artifact`);
    }
  }
}

async function validatePackageTree(
  repositoryRoot: string,
  packageRoot: string,
  errors: string[],
): Promise<void> {
  const pending = [packageRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    try {
      if (await hasSymbolicLinkComponent(repositoryRoot, current)) {
        errors.push(`${current} must not contain a symbolic link`);
        continue;
      }
      const currentPath = await resolveExistingPathWithinRoot(repositoryRoot, current);
      const entries = await readdir(currentPath, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const child = `${current}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          errors.push(`${child} must not be a symbolic link`);
        } else if (entry.isDirectory()) {
          pending.push(child);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          await validateMarkdownReferences(repositoryRoot, child, packageRoot, errors);
        }
      }
    } catch (error: unknown) {
      if (isMissingPath(error) || error instanceof SaberError) {
        errors.push(`missing asset package ${packageRoot}`);
      } else {
        errors.push(`could not inspect asset package ${packageRoot}`);
      }
    }
  }
}

async function validateSkillPackage(
  repositoryRoot: string,
  directory: "workflows" | "skills",
  packageName: string,
  errors: string[],
): Promise<void> {
  const packageRoot = `${directory}/${packageName}`;
  const entrypoint = `${packageRoot}/SKILL.md`;
  if (!(await isRegularFileWithinRoot(repositoryRoot, entrypoint))) {
    errors.push(`missing skill entrypoint ${entrypoint}`);
    return;
  }

  await validatePackageTree(repositoryRoot, packageRoot, errors);
}

/**
 * Verify the framework-owned Markdown contracts without following symlinks or
 * trusting references outside a skill/workflow package.
 */
export async function validateRepositoryAssets(repositoryRoot: string): Promise<string[]> {
  const errors: string[] = [];
  const roles = await listAssetDirectory(repositoryRoot, "roles", errors);
  const workflows = await listAssetDirectory(repositoryRoot, "workflows", errors);
  const skills = await listAssetDirectory(repositoryRoot, "skills", errors);

  if (roles !== undefined) {
    const roleNames = new Set(roles.filter((entry) => entry.isFile()).map((entry) => entry.name));
    for (const roleFile of requiredRoleFiles) {
      if (
        !roleNames.has(roleFile) ||
        !(await isRegularFileWithinRoot(repositoryRoot, `roles/${roleFile}`))
      ) {
        errors.push(`missing role asset roles/${roleFile}`);
      }
    }
    for (const role of roles) {
      if (role.isSymbolicLink()) {
        errors.push(`roles/${role.name} must not be a symbolic link`);
      }
    }
  }

  if (workflows !== undefined) {
    const names = new Set(workflows.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const workflow of requiredWorkflowPackages) {
      if (!names.has(workflow)) {
        errors.push(`missing asset package workflows/${workflow}`);
      } else {
        await validateSkillPackage(repositoryRoot, "workflows", workflow, errors);
      }
    }
    for (const workflow of workflows) {
      if (workflow.isSymbolicLink()) {
        errors.push(`workflows/${workflow.name} must not be a symbolic link`);
      } else if (
        workflow.isDirectory() &&
        !requiredWorkflowPackageNames.includes(workflow.name)
      ) {
        await validateSkillPackage(repositoryRoot, "workflows", workflow.name, errors);
      }
    }
  }

  if (skills !== undefined) {
    const names = new Set(skills.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const skill of requiredSkillPackages) {
      if (!names.has(skill)) {
        errors.push(`missing asset package skills/${skill}`);
      } else {
        await validateSkillPackage(repositoryRoot, "skills", skill, errors);
      }
    }
    for (const skill of skills) {
      if (skill.isSymbolicLink()) {
        errors.push(`skills/${skill.name} must not be a symbolic link`);
      } else if (skill.isDirectory() && !requiredSkillPackageNames.includes(skill.name)) {
        await validateSkillPackage(repositoryRoot, "skills", skill.name, errors);
      }
    }
  }

  return errors;
}

/** Validate configuration and all checked-in role/workflow/team-skill contracts. */
export async function collectValidationReport(
  repositoryRoot: string,
  dependencies: ValidateCommandDependencies = {},
): Promise<ValidationReport> {
  const errors: string[] = [];
  const loadConfig = dependencies.loadConfig ?? loadRepositoryConfig;
  try {
    const config = await loadConfig(repositoryRoot);
    errors.push(...validateRepositoryConfig(config));
  } catch (error: unknown) {
    errors.push(safeErrorMessage(error));
  }

  const validateAssets = dependencies.validateAssets ?? validateRepositoryAssets;
  try {
    errors.push(...(await validateAssets(repositoryRoot)));
  } catch {
    errors.push("could not validate checked-in assets");
  }

  return { valid: errors.length === 0, errors };
}

function formatValidationReport(report: ValidationReport): string {
  if (report.valid) {
    return "Validation passed.\n";
  }

  return `Validation failed:\n${report.errors.map((error) => `- ${error}`).join("\n")}\n`;
}

/** Run `saber validate [--json]`. */
export async function runValidateCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: ValidateCommandDependencies },
): Promise<ValidateCommandResult> {
  const requestedJson = argv.includes("--json");
  try {
    const parsed = parseBooleanArguments(argv, ["--json"]);
    if (parsed.positionals.length > 0) {
      throw new SaberError("validate accepts no positional arguments", 2);
    }
    const report = await collectValidationReport(cwd, dependencies);
    return {
      exitCode: report.valid ? 0 : 2,
      stdout: parsed.flags.has("--json") ? asJson(report) : formatValidationReport(report),
      stderr: "",
    };
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      return requestedJson
        ? {
            exitCode: error.exitCode,
            stdout: asJson({ valid: false, errors: [error.message] }),
            stderr: "",
          }
        : { exitCode: error.exitCode, stdout: "", stderr: `${error.message}\n` };
    }
    return requestedJson
      ? {
          exitCode: 1,
          stdout: asJson({ valid: false, errors: ["validate command failed"] }),
          stderr: "",
        }
      : { exitCode: 1, stdout: "", stderr: "validate command failed\n" };
  }
}
