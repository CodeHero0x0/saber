import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { SaberError } from "./errors.js";
import { resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import { isSafeExternalAssetSource } from "./validation.js";

export const workitemRoles = ["ba", "dev", "qa"] as const;
export type WorkitemRole = (typeof workitemRoles)[number];

export type WorkitemRepositoryReference = {
  name: string;
  path: string;
  repository?: string;
};

/** Current, source-verified repository delivery references kept in repositories.yaml. */
export type WorkitemRepositoryEvidence = WorkitemRepositoryReference & {
  branch: string | null;
  commit: string | null;
  mergeRequest: string | null;
  ci: string | null;
};

export type WorkitemMetadata = {
  schemaVersion: 1;
  key: string;
  jira: {
    url: string;
    fingerprint: string;
    /** Omitted until a real Jira L0 intake supplies the source updatedAt fact. */
    updatedAt?: string;
  };
  repositories: WorkitemRepositoryReference[];
};

export type WorkitemCreateInput = {
  key: string;
  jiraUrl: string;
  fingerprint: string;
  /** A Jira-provided ISO-8601 updatedAt fact. Never synthesized from local time. */
  updatedAt?: string;
  /** Preferred explicit repository references, resolved by the CLI from saber.yaml. */
  repositories?: readonly WorkitemRepositoryReference[];
  /** Compatibility shorthand for callers that only know selected project names. */
  projects?: readonly string[];
};

export type WorkitemHandoffInput = {
  key: string;
  role: WorkitemRole | string;
  summary: string;
  risk: string;
  next: string;
  now?: Date;
};

export type WorkitemHandoffRecord = {
  path: string;
  recordedAt: string;
  role: WorkitemRole;
};

export type WorkitemDriftReport = {
  key: string;
  state: "current" | "paused";
  savedFingerprint: string;
  currentFingerprint: string;
};

export type WorkitemArtifactState = {
  path: string;
  state: "present" | "missing" | "invalid";
  /** A static, safe diagnostic; never echo untrusted evidence content. */
  detail?: string;
};

export type WorkitemStatusReport = {
  key: string;
  jiraUrl: string;
  fingerprint: string;
  /** Null means the local workitem was created before an intake supplied this Jira fact. */
  updatedAt: string | null;
  artifacts: WorkitemArtifactState[];
  repositories: WorkitemRepositoryEvidence[];
  handoffCount: number;
};

const requiredArtifactPaths = [
  "workitem.yaml",
  "requirements.md",
  "design.md",
  "plan.md",
  "tests.md",
  "repositories.yaml",
  "handoffs/README.md",
  "decisions/README.md",
] as const;

const templatePaths = [
  "workitem.yaml",
  "requirements.md",
  "design.md",
  "plan.md",
  "tests.md",
  "repositories.yaml",
  "handoffs/README.md",
  "decisions/README.md",
] as const;

const templateDirectory = fileURLToPath(new URL("../../templates/workitem/", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isControlText(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
}

function safeProjectName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateWorkitemKey(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]*$/u.test(value)) {
    throw new SaberError("invalid workitem key; expected an uppercase Jira key such as PROJ-123", 2);
  }
  return value;
}

function validateFingerprint(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+=-]{0,255}$/u.test(value)) {
    throw new SaberError("invalid workitem fingerprint", 2);
  }
  return value;
}

const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/u;

/**
 * Keep the source timestamp distinct from local command time: absent remains
 * absent, while a supplied Jira ISO timestamp is normalized to its UTC instant.
 */
function validateUpdatedAt(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = isoTimestamp.exec(value);
  if (match === null) {
    throw new SaberError("invalid Jira updatedAt timestamp", 2);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7] ?? "";
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  const offset = zone === "Z" ? undefined : zone.slice(1).replace(":", "");
  const offsetHour = offset === undefined ? 0 : Number(offset.slice(0, 2));
  const offsetMinute = offset === undefined ? 0 : Number(offset.slice(2, 4));
  if (
    year < 1 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new SaberError("invalid Jira updatedAt timestamp", 2);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new SaberError("invalid Jira updatedAt timestamp", 2);
  }
  return new Date(timestamp).toISOString();
}

function validateJiraUrl(value: string): string {
  if (value.length === 0 || value.length > 2_048 || isControlText(value)) {
    throw new SaberError("invalid Jira URL", 2);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SaberError("invalid Jira URL", 2);
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new SaberError("Jira URL must be credential-free HTTPS without query or fragment", 2);
  }
  return url.toString();
}

function validateShortText(label: string, value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 4_000 ||
    isControlText(normalized) ||
    normalized.includes("\n") ||
    normalized.includes("\r")
  ) {
    throw new SaberError(`invalid ${label}`, 2);
  }
  return normalized;
}

function validateRole(role: string): WorkitemRole {
  if (!workitemRoles.includes(role as WorkitemRole)) {
    throw new SaberError("invalid handoff role; expected ba, dev, or qa", 2);
  }
  return role as WorkitemRole;
}

function normalizeRepositoryReference(value: unknown): WorkitemRepositoryReference {
  if (!isRecord(value) || typeof value.name !== "string" || !safeProjectName(value.name)) {
    throw new SaberError("invalid workitem repository name", 2);
  }
  if (
    !hasOnlyKeys(value, ["name", "path", "repository"]) ||
    typeof value.path !== "string" ||
    !safeRepositoryPath(value.path) ||
    isControlText(value.path)
  ) {
    throw new SaberError(`invalid path for workitem repository ${value.name}`, 2);
  }
  if (
    value.repository !== undefined &&
    (typeof value.repository !== "string" ||
      value.repository.length === 0 ||
      value.repository.length > 2_048 ||
      isControlText(value.repository) ||
      !isSafeExternalAssetSource(value.repository))
  ) {
    throw new SaberError(`invalid source for workitem repository ${value.name}`, 2);
  }
  return value.repository === undefined
    ? { name: value.name, path: value.path }
    : { name: value.name, path: value.path, repository: value.repository };
}

function validateStableReference(
  label: string,
  value: unknown,
  allowLeadingBang = false,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const allowedReference = allowLeadingBang
    ? /^[A-Za-z0-9!][A-Za-z0-9._!:/-]*$/u
    : /^[A-Za-z0-9][A-Za-z0-9._!:/-]*$/u;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    isControlText(value) ||
    !allowedReference.test(value)
  ) {
    throw new SaberError(`invalid repository ${label}`, 2);
  }
  return value;
}

function normalizeRepositoryEvidence(value: unknown): WorkitemRepositoryEvidence {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["name", "path", "repository", "branch", "commit", "mergeRequest", "ci"])
  ) {
    throw new SaberError("invalid repository evidence", 2);
  }
  const reference = normalizeRepositoryReference({
    name: value.name,
    path: value.path,
    ...(value.repository === undefined ? {} : { repository: value.repository }),
  });
  const branch = validateStableReference("branch", value.branch);
  const commit = value.commit === undefined || value.commit === null
    ? null
    : typeof value.commit === "string" && /^[0-9a-fA-F]{7,64}$/u.test(value.commit)
      ? value.commit.toLowerCase()
      : (() => {
          throw new SaberError("invalid repository commit", 2);
        })();
  return {
    ...reference,
    branch,
    commit,
    mergeRequest: validateStableReference("merge request", value.mergeRequest, true),
    ci: validateStableReference("CI reference", value.ci),
  };
}

function sameRepositoryReference(
  metadata: WorkitemRepositoryReference,
  evidence: WorkitemRepositoryEvidence,
): boolean {
  return (
    metadata.name === evidence.name &&
    metadata.path === evidence.path &&
    metadata.repository === evidence.repository
  );
}

type RepositoryEvidenceReadResult = {
  artifact: WorkitemArtifactState;
  repositories: WorkitemRepositoryEvidence[];
};

function unresolvedRepositoryEvidence(
  metadata: WorkitemMetadata,
): WorkitemRepositoryEvidence[] {
  return metadata.repositories.map((repository) => ({
    ...repository,
    branch: null,
    commit: null,
    mergeRequest: null,
    ci: null,
  }));
}

function repositoryEvidenceDiagnostic(
  metadata: WorkitemMetadata,
  state: "missing" | "invalid",
  detail?: string,
): RepositoryEvidenceReadResult {
  return {
    artifact: {
      path: "repositories.yaml",
      state,
      ...(detail === undefined ? {} : { detail }),
    },
    repositories: unresolvedRepositoryEvidence(metadata),
  };
}

/**
 * These fields can later affect repository navigation or be rendered in a
 * handoff. Reject unsafe paths and remotes outright rather than treating them
 * as ordinary incomplete evidence.
 */
function hasUnsafeRepositoryEvidence(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.repository !== undefined && !isSafeExternalAssetSource(value.repository)) {
    return true;
  }
  return (
    typeof value.path === "string" &&
    (!safeRepositoryPath(value.path) || isControlText(value.path))
  );
}

function matchRepositoryEvidenceByName(
  metadata: WorkitemMetadata,
  repositories: readonly WorkitemRepositoryEvidence[],
): { repositories: WorkitemRepositoryEvidence[] } | { detail: string } {
  const evidenceByName = new Map<string, WorkitemRepositoryEvidence>();
  for (const repository of repositories) {
    if (evidenceByName.has(repository.name)) {
      return { detail: "duplicate repository target" };
    }
    evidenceByName.set(repository.name, repository);
  }

  const targetsByName = new Map(metadata.repositories.map((repository) => [repository.name, repository]));
  for (const repository of repositories) {
    const target = targetsByName.get(repository.name);
    if (target === undefined) {
      return { detail: "unknown repository target" };
    }
    if (!sameRepositoryReference(target, repository)) {
      return { detail: "repository target does not match workitem" };
    }
  }

  const orderedRepositories: WorkitemRepositoryEvidence[] = [];
  for (const target of metadata.repositories) {
    const repository = evidenceByName.get(target.name);
    if (repository === undefined) {
      return { detail: "missing repository target" };
    }
    orderedRepositories.push(repository);
  }
  return { repositories: orderedRepositories };
}

function normalizeRepositories(input: WorkitemCreateInput): WorkitemRepositoryReference[] {
  if (input.repositories !== undefined && input.projects !== undefined) {
    throw new SaberError("workitem creation accepts repositories or projects, not both", 2);
  }
  const raw =
    input.repositories ??
    input.projects?.map((name) => ({ name, path: `projects/${name}` }));
  if (raw === undefined || raw.length === 0) {
    throw new SaberError("workitem create requires at least one project", 2);
  }

  const names = new Set<string>();
  const repositories: WorkitemRepositoryReference[] = [];
  for (const reference of raw) {
    const normalized = normalizeRepositoryReference(reference);
    if (names.has(normalized.name)) {
      throw new SaberError(`duplicate workitem repository ${normalized.name}`, 2);
    }
    names.add(normalized.name);
    repositories.push(normalized);
  }
  return repositories;
}

function workitemRootPath(key: string): string {
  return `workitems/${key}`;
}

function workitemRelativePath(key: string, child?: string): string {
  return child === undefined ? workitemRootPath(key) : `${workitemRootPath(key)}/${child}`;
}

function resolveWorkitemWithinRoot(repositoryRoot: string, relativePath: string): string {
  try {
    return resolveWithinRoot(repositoryRoot, relativePath);
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      // A workitem path is always user/configuration supplied state, so path
      // rejection is a command-input error rather than an internal failure.
      throw new SaberError(error.message, 2);
    }
    throw error;
  }
}

/** Refuse every symbolic-link component, including an in-repository link. */
async function assertNoSymbolicLinkComponents(
  repositoryRoot: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = resolveWorkitemWithinRoot(repositoryRoot, relativePath);
  const root = resolveWorkitemWithinRoot(repositoryRoot, ".");
  const fromRoot = relative(root, absolutePath);
  if (fromRoot === "" || fromRoot === ".") {
    return;
  }

  let current = root;
  for (const component of fromRoot.split(/[\\/]/u)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new SaberError(`workitem path contains a symbolic link: ${relativePath}`, 2);
      }
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        return;
      }
      throw error;
    }
  }
}

async function prepareWorkitemsDirectory(repositoryRoot: string): Promise<void> {
  await assertNoSymbolicLinkComponents(repositoryRoot, "workitems");
  const path = resolveWorkitemWithinRoot(repositoryRoot, "workitems");
  await mkdir(path, { recursive: true });
  await assertNoSymbolicLinkComponents(repositoryRoot, "workitems");
}

async function resolveWorkitemPath(
  repositoryRoot: string,
  key: string,
  child?: string,
): Promise<string> {
  const relativePath = workitemRelativePath(key, child);
  await assertNoSymbolicLinkComponents(repositoryRoot, relativePath);
  return resolveWorkitemWithinRoot(repositoryRoot, relativePath);
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/gu, (whole, name: string) => values[name] ?? whole);
}

async function loadTemplates(): Promise<Map<string, string>> {
  try {
    const templates = await Promise.all(
      templatePaths.map(async (path) => [path, await readFile(join(templateDirectory, path), "utf8")] as const),
    );
    return new Map(templates);
  } catch {
    throw new SaberError("could not load workitem templates", 1);
  }
}

function requiredTemplate(templates: ReadonlyMap<string, string>, path: string): string {
  const template = templates.get(path);
  if (template === undefined) {
    throw new SaberError("could not load workitem templates", 1);
  }
  return template;
}

function metadataFor(
  key: string,
  jiraUrl: string,
  fingerprint: string,
  updatedAt: string | undefined,
  repositories: WorkitemRepositoryReference[],
): WorkitemMetadata {
  return {
    schemaVersion: 1,
    key,
    jira: {
      url: jiraUrl,
      fingerprint,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    },
    repositories,
  };
}

function repositoryEvidenceFor(repositories: readonly WorkitemRepositoryReference[]): object {
  return {
    schemaVersion: 1,
    repositories: repositories.map((repository) => ({
      ...repository,
      branch: null,
      commit: null,
      mergeRequest: null,
      ci: "not-recorded",
    })),
  };
}

async function writeNewFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
}

function duplicateWorkitemError(key: string): SaberError {
  return new SaberError(`workitem ${key} already exists; refusing to overwrite it`, 2);
}

/**
 * Create the complete local evidence pack once. The target directory is first
 * reserved with non-recursive mkdir, so an existing workitem is never replaced.
 */
export async function createWorkitem(
  repositoryRoot: string,
  input: WorkitemCreateInput,
): Promise<WorkitemMetadata> {
  const key = validateWorkitemKey(input.key);
  const jiraUrl = validateJiraUrl(input.jiraUrl);
  const fingerprint = validateFingerprint(input.fingerprint);
  const updatedAt = validateUpdatedAt(input.updatedAt);
  const repositories = normalizeRepositories(input);
  for (const repository of repositories) {
    // This checks both lexical traversal and existing escaping symlinks.
    resolveWorkitemWithinRoot(repositoryRoot, repository.path);
  }

  await prepareWorkitemsDirectory(repositoryRoot);
  const workitemPath = await resolveWorkitemPath(repositoryRoot, key);
  let created = false;
  try {
    try {
      await mkdir(workitemPath);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw duplicateWorkitemError(key);
      }
      throw error;
    }
    created = true;
    await assertNoSymbolicLinkComponents(repositoryRoot, workitemRootPath(key));

    const handoffsPath = await resolveWorkitemPath(repositoryRoot, key, "handoffs");
    const decisionsPath = await resolveWorkitemPath(repositoryRoot, key, "decisions");
    await mkdir(handoffsPath);
    await mkdir(decisionsPath);

    const templates = await loadTemplates();
    const metadata = metadataFor(key, jiraUrl, fingerprint, updatedAt, repositories);
    const values = {
      KEY: key,
      JIRA_URL: jiraUrl,
      FINGERPRINT: fingerprint,
      WORKITEM_YAML: stringify(metadata),
      REPOSITORIES_YAML: stringify(repositoryEvidenceFor(repositories)),
    };
    for (const templatePath of templatePaths) {
      const destination = await resolveWorkitemPath(repositoryRoot, key, templatePath);
      await writeNewFile(destination, renderTemplate(requiredTemplate(templates, templatePath), values));
    }
    return metadata;
  } catch (error: unknown) {
    if (created) {
      // Only remove the unique directory this invocation successfully reserved.
      await rm(workitemPath, { recursive: true, force: true });
    }
    if (error instanceof SaberError) {
      throw error;
    }
    throw new SaberError("could not create workitem evidence pack", 1);
  }
}

function normalizeMetadata(value: unknown): WorkitemMetadata | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "key", "jira", "repositories"]) ||
    value.schemaVersion !== 1 ||
    typeof value.key !== "string" ||
    !isRecord(value.jira) ||
    !hasOnlyKeys(value.jira, ["url", "fingerprint", "updatedAt"]) ||
    typeof value.jira.url !== "string" ||
    typeof value.jira.fingerprint !== "string" ||
    (value.jira.updatedAt !== undefined && typeof value.jira.updatedAt !== "string") ||
    !Array.isArray(value.repositories)
  ) {
    return undefined;
  }
  try {
    const key = validateWorkitemKey(value.key);
    const jiraUrl = validateJiraUrl(value.jira.url);
    const fingerprint = validateFingerprint(value.jira.fingerprint);
    const updatedAt = validateUpdatedAt(value.jira.updatedAt as string | undefined);
    const repositories = normalizeRepositories({
      key,
      jiraUrl,
      fingerprint,
      repositories: value.repositories as WorkitemRepositoryReference[],
    });
    return {
      schemaVersion: 1,
      key,
      jira: {
        url: jiraUrl,
        fingerprint,
        ...(updatedAt === undefined ? {} : { updatedAt }),
      },
      repositories,
    };
  } catch {
    return undefined;
  }
}

async function readWorkitemRepositoryEvidence(
  repositoryRoot: string,
  key: string,
  metadata: WorkitemMetadata,
): Promise<RepositoryEvidenceReadResult> {
  const relativePath = workitemRelativePath(key, "repositories.yaml");
  await assertNoSymbolicLinkComponents(repositoryRoot, relativePath);
  let path: string;
  try {
    path = await resolveExistingPathWithinRoot(repositoryRoot, relativePath);
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      throw error;
    }
    if (isMissingPath(error)) {
      return repositoryEvidenceDiagnostic(metadata, "missing");
    }
    return repositoryEvidenceDiagnostic(metadata, "invalid", "repository evidence is unavailable");
  }

  let status;
  try {
    status = await lstat(path);
  } catch {
    return repositoryEvidenceDiagnostic(metadata, "invalid", "repository evidence is unavailable");
  }
  if (status.isSymbolicLink()) {
    throw new SaberError(`workitem ${key} has invalid repository evidence`, 2);
  }
  if (!status.isFile()) {
    return repositoryEvidenceDiagnostic(metadata, "invalid", "invalid repository evidence");
  }

  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, "utf8"));
  } catch {
    return repositoryEvidenceDiagnostic(metadata, "invalid", "invalid repository evidence");
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["schemaVersion", "repositories"]) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.repositories)
  ) {
    return repositoryEvidenceDiagnostic(metadata, "invalid", "invalid repository evidence");
  }

  const repositories: WorkitemRepositoryEvidence[] = [];
  for (const rawRepository of parsed.repositories) {
    if (hasUnsafeRepositoryEvidence(rawRepository)) {
      throw new SaberError(`workitem ${key} has invalid repository evidence`, 2);
    }
    try {
      repositories.push(normalizeRepositoryEvidence(rawRepository));
    } catch {
      return repositoryEvidenceDiagnostic(metadata, "invalid", "invalid repository evidence");
    }
  }

  const matched = matchRepositoryEvidenceByName(metadata, repositories);
  if ("detail" in matched) {
    return repositoryEvidenceDiagnostic(metadata, "invalid", matched.detail);
  }
  return { artifact: { path: "repositories.yaml", state: "present" }, repositories: matched.repositories };
}

/** Read only canonical workitem metadata; no conversation/chat state is consulted. */
export async function readWorkitemMetadata(
  repositoryRoot: string,
  rawKey: string,
): Promise<WorkitemMetadata> {
  const key = validateWorkitemKey(rawKey);
  const relativePath = workitemRelativePath(key, "workitem.yaml");
  await assertNoSymbolicLinkComponents(repositoryRoot, relativePath);
  try {
    const path = await resolveExistingPathWithinRoot(repositoryRoot, relativePath);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new SaberError(`workitem ${key} has invalid metadata`, 2);
    }
    let parsed: unknown;
    try {
      parsed = parse(await readFile(path, "utf8"));
    } catch {
      throw new SaberError(`workitem ${key} has invalid metadata`, 2);
    }
    const metadata = normalizeMetadata(parsed);
    if (metadata === undefined || metadata.key !== key) {
      throw new SaberError(`workitem ${key} has invalid metadata`, 2);
    }
    return metadata;
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      throw error;
    }
    if (isMissingPath(error)) {
      throw new SaberError(`workitem ${key} does not exist`, 2);
    }
    throw new SaberError(`could not read workitem ${key}`, 1);
  }
}

function handoffFilename(recordedAt: string, role: WorkitemRole, sequence = 0): string {
  const timestamp = recordedAt.replaceAll(":", "-");
  return `${timestamp}-${role}${sequence === 0 ? "" : `-${sequence}`}.md`;
}

function renderHandoff(
  key: string,
  recordedAt: string,
  role: WorkitemRole,
  summary: string,
  risk: string,
  next: string,
): string {
  return `# Handoff — ${key}\n\n- Recorded at (UTC): \`${recordedAt}\`\n- From role: \`${role}\`\n\n## Summary\n\n${summary}\n\n## Risks / blockers\n\n${risk}\n\n## Next human action\n\n${next}\n`;
}

/** Append a compact timestamped handoff record; it deliberately never edits chat history. */
export async function appendWorkitemHandoff(
  repositoryRoot: string,
  input: WorkitemHandoffInput,
): Promise<WorkitemHandoffRecord> {
  const key = validateWorkitemKey(input.key);
  const role = validateRole(input.role);
  const summary = validateShortText("handoff summary", input.summary);
  const risk = validateShortText("handoff risk", input.risk);
  const next = validateShortText("handoff next action", input.next);
  await readWorkitemMetadata(repositoryRoot, key);

  const handoffsPath = await resolveWorkitemPath(repositoryRoot, key, "handoffs");
  try {
    const status = await lstat(handoffsPath);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new SaberError(`workitem ${key} has invalid handoffs directory`, 2);
    }
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      throw error;
    }
    if (isMissingPath(error)) {
      throw new SaberError(`workitem ${key} is missing handoffs/README.md`, 2);
    }
    throw new SaberError(`could not write handoff for workitem ${key}`, 1);
  }

  const date = input.now ?? new Date();
  if (Number.isNaN(date.getTime())) {
    throw new SaberError("invalid handoff timestamp", 2);
  }
  const recordedAt = date.toISOString();
  for (let sequence = 0; sequence < 100; sequence += 1) {
    const filename = handoffFilename(recordedAt, role, sequence);
    const destination = await resolveWorkitemPath(repositoryRoot, key, `handoffs/${filename}`);
    try {
      await writeFile(destination, renderHandoff(key, recordedAt, role, summary, risk, next), {
        encoding: "utf8",
        flag: "wx",
      });
      return { path: `handoffs/${filename}`, recordedAt, role };
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        continue;
      }
      if (error instanceof SaberError) {
        throw error;
      }
      throw new SaberError(`could not write handoff for workitem ${key}`, 1);
    }
  }
  throw new SaberError(`could not append handoff for workitem ${key}; retry later`, 1);
}

export async function compareWorkitemFingerprint(
  repositoryRoot: string,
  rawKey: string,
  rawFingerprint: string,
): Promise<WorkitemDriftReport> {
  const metadata = await readWorkitemMetadata(repositoryRoot, rawKey);
  const currentFingerprint = validateFingerprint(rawFingerprint);
  return {
    key: metadata.key,
    state: metadata.jira.fingerprint === currentFingerprint ? "current" : "paused",
    savedFingerprint: metadata.jira.fingerprint,
    currentFingerprint,
  };
}

async function artifactState(
  repositoryRoot: string,
  key: string,
  path: string,
): Promise<WorkitemArtifactState> {
  try {
    const absolutePath = await resolveWorkitemPath(repositoryRoot, key, path);
    const status = await lstat(absolutePath);
    return { path, state: status.isFile() && !status.isSymbolicLink() ? "present" : "missing" };
  } catch {
    return { path, state: "missing" };
  }
}

async function countHandoffs(repositoryRoot: string, key: string): Promise<number> {
  try {
    const handoffsPath = await resolveWorkitemPath(repositoryRoot, key, "handoffs");
    const entries = await readdir(handoffsPath, { withFileTypes: true, encoding: "utf8" });
    return entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== "README.md" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-(ba|dev|qa)(-\d+)?\.md$/u.test(
          entry.name,
        ),
    ).length;
  } catch {
    return 0;
  }
}

/** Report only defined evidence artifacts and repository references, never chat history. */
export async function getWorkitemStatus(
  repositoryRoot: string,
  rawKey: string,
): Promise<WorkitemStatusReport> {
  const metadata = await readWorkitemMetadata(repositoryRoot, rawKey);
  const repositoryEvidence = await readWorkitemRepositoryEvidence(repositoryRoot, metadata.key, metadata);
  const artifacts = await Promise.all(
    requiredArtifactPaths.map((path) => artifactState(repositoryRoot, metadata.key, path)),
  );
  return {
    key: metadata.key,
    jiraUrl: metadata.jira.url,
    fingerprint: metadata.jira.fingerprint,
    updatedAt: metadata.jira.updatedAt ?? null,
    artifacts: artifacts.map((artifact) =>
      artifact.path === "repositories.yaml" ? repositoryEvidence.artifact : artifact,
    ),
    repositories: repositoryEvidence.repositories,
    handoffCount: await countHandoffs(repositoryRoot, metadata.key),
  };
}
