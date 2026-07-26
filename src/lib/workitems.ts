import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { readDefaultAsset } from "./default-assets.js";
import { SaberError } from "./errors.js";
import { parseMarkdownFrontMatter, renderMarkdownFrontMatter } from "./frontmatter.js";
import { resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import { formatSchemaIssues, workitemFrontMatterSchema, type WorkitemFrontMatter } from "./schemas.js";
import { isSafeExternalAssetSource } from "./validation.js";

export const workitemSourceKinds = ["chat", "jira", "document", "manual"] as const;
export type WorkitemSourceKind = (typeof workitemSourceKinds)[number];

export type WorkitemRepositoryReference = {
  id: string;
  path: string;
  repository?: string;
};

export type WorkitemCreateInput = {
  key?: string;
  source: {
    kind: WorkitemSourceKind | string;
    title: string;
    content: string;
    origin?: string;
    capturedAt?: string;
    references?: readonly string[];
  };
  repositories?: readonly WorkitemRepositoryReference[];
  now?: Date;
};

export type Workitem = {
  key: string;
  path: string;
  source: {
    kind: WorkitemSourceKind;
    title: string;
    origin?: string;
    capturedAt: string;
    references: string[];
  };
  repositories: WorkitemRepositoryReference[];
};

export type WorkitemStatusReport = {
  key: string;
  path: string;
  state: "valid" | "invalid" | "missing";
  errors: string[];
  risks: string[];
};

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function validText(value: string, label: string, limit = 4_000): string {
  if (value.trim().length === 0 || value.length > limit || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new SaberError(`invalid ${label}`, 2);
  }
  return value.trim();
}

function validateSourceKind(value: string): WorkitemSourceKind {
  if (!workitemSourceKinds.includes(value as WorkitemSourceKind)) {
    throw new SaberError("invalid source type", 2);
  }
  return value as WorkitemSourceKind;
}

function validateTimestamp(value: string | undefined, now: Date | undefined): string {
  if (value !== undefined) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
      throw new SaberError("invalid captured timestamp", 2);
    }
    return value;
  }
  const date = now ?? new Date();
  if (Number.isNaN(date.getTime())) throw new SaberError("invalid workitem date", 2);
  return date.toISOString();
}

function normalizeWorkitemKey(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (normalized.length === 0 || normalized.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N}-]*$/u.test(normalized)) {
    throw new SaberError("workitem name must be a short Jira key or descriptive title", 2);
  }
  return normalized;
}

function uniqueStrings(values: readonly string[] | undefined, label: string): string[] {
  const result = (values ?? []).map((value) => validText(value, label, 1_000));
  if (new Set(result).size !== result.length) throw new SaberError(`duplicate ${label}`, 2);
  return result;
}

function normalizeRepositories(value: readonly WorkitemRepositoryReference[] | undefined): WorkitemRepositoryReference[] {
  const repositories = value ?? [];
  const ids = new Set<string>();
  return repositories.map((repository) => {
    const id = validText(repository.id, "repository id", 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) throw new SaberError("invalid repository id", 2);
    if (ids.has(id)) throw new SaberError("duplicate repository id", 2);
    ids.add(id);
    const path = validText(repository.path, "repository path", 512);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new SaberError("invalid repository path", 2);
    }
    const remote = repository.repository === undefined ? undefined : validText(repository.repository, "repository remote", 1_000);
    if (remote !== undefined && !isSafeExternalAssetSource(remote)) {
      throw new SaberError("invalid repository remote", 2);
    }
    return { id, path, ...(remote === undefined ? {} : { repository: remote }) };
  });
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/gu, (whole, name: string) => values[name] ?? whole);
}

async function loadTemplate(): Promise<string> {
  return readDefaultAsset("templates/workitem/workitem.md");
}

async function existingWorkitemKeys(repositoryRoot: string): Promise<Set<string>> {
  const root = resolveWithinRoot(repositoryRoot, "workitems");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return new Set(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3)));
  } catch (error: unknown) {
    if (isMissing(error)) return new Set();
    throw new SaberError("could not inspect workitems", 1);
  }
}

async function allocateWorkitemKey(repositoryRoot: string, requested: string | undefined, title: string): Promise<string> {
  const base = normalizeWorkitemKey(requested ?? title);
  const existing = await existingWorkitemKeys(repositoryRoot);
  if (requested !== undefined) {
    if (existing.has(base)) throw new SaberError(`workitem ${base} already exists; refusing to overwrite it`, 2);
    return base;
  }
  if (!existing.has(base)) return base;
  for (let number = 2; number <= 999; number += 1) {
    const candidate = `${base.slice(0, Math.max(1, 76 - String(number).length))}-${number}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new SaberError("could not allocate a unique workitem name", 1);
}

function risksFromWorkitem(workitem: WorkitemFrontMatter): string[] {
  return workitem.risks.filter((risk) => risk.status === "open").map((risk) => `${risk.id}: ${risk.summary}`);
}

/** Create the single Markdown workitem used by the /saber routing skill. */
export async function createWorkitem(repositoryRoot: string, input: WorkitemCreateInput): Promise<Workitem> {
  const kind = validateSourceKind(input.source.kind);
  const title = validText(input.source.title, "source title", 240);
  const content = validText(input.source.content, "source content", 40_000);
  const origin = input.source.origin === undefined ? undefined : validText(input.source.origin, "source origin", 1_000);
  const references = uniqueStrings(input.source.references, "source reference");
  const capturedAt = validateTimestamp(input.source.capturedAt, input.now);
  const repositories = normalizeRepositories(input.repositories);
  for (const repository of repositories) resolveWithinRoot(repositoryRoot, repository.path);

  const key = await allocateWorkitemKey(repositoryRoot, input.key, title);
  const path = `workitems/${key}.md`;
  const frontMatter: WorkitemFrontMatter = {
    schemaVersion: 1,
    id: key,
    title,
    source: { kind, capturedAt, references, ...(origin === undefined ? {} : { origin }) },
    repositories,
    dependencies: { requires: [], blockedBy: [] },
    decisions: [],
    knowledgeImpact: { conclusion: "pending-user-decision", entries: [] },
    risks: [],
  };
  const validated = workitemFrontMatterSchema.safeParse(frontMatter);
  if (!validated.success) throw new SaberError("could not build valid workitem front matter", 1);

  await mkdir(resolveWithinRoot(repositoryRoot, "workitems"), { recursive: true });
  const body = render(await loadTemplate(), { SOURCE_CONTENT: content });
  try {
    await writeFile(resolveWithinRoot(repositoryRoot, path), renderMarkdownFrontMatter(validated.data, body), { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
      throw new SaberError(`workitem ${key} already exists; refusing to overwrite it`, 2);
    }
    throw error;
  }

  return { key, path, source: { kind, title, ...(origin === undefined ? {} : { origin }), capturedAt, references }, repositories };
}

export async function getWorkitemStatus(repositoryRoot: string, rawKey: string): Promise<WorkitemStatusReport> {
  const key = normalizeWorkitemKey(rawKey);
  const path = `workitems/${key}.md`;
  let content: string;
  try {
    const target = await resolveExistingPathWithinRoot(repositoryRoot, path);
    const status = await lstat(target);
    if (!status.isFile() || status.isSymbolicLink()) {
      return { key, path, state: "invalid", errors: ["workitem must be a regular Markdown file"], risks: [] };
    }
    content = await readFile(target, "utf8");
  } catch (error: unknown) {
    if (isMissing(error) || error instanceof SaberError) return { key, path, state: "missing", errors: [`workitem ${key} does not exist`], risks: [] };
    return { key, path, state: "invalid", errors: ["could not read workitem"], risks: [] };
  }

  try {
    const parsed = parseMarkdownFrontMatter(content);
    const validated = workitemFrontMatterSchema.safeParse(parsed.attributes);
    if (!validated.success) {
      return { key, path, state: "invalid", errors: formatSchemaIssues(validated.error), risks: [] };
    }
    if (validated.data.id !== key) {
      return { key, path, state: "invalid", errors: ["id must match the workitem filename"], risks: [] };
    }
    return { key, path, state: "valid", errors: [], risks: risksFromWorkitem(validated.data) };
  } catch (error: unknown) {
    if (error instanceof SaberError) return { key, path, state: "invalid", errors: [error.message], risks: [] };
    return { key, path, state: "invalid", errors: ["could not validate workitem"], risks: [] };
  }
}
