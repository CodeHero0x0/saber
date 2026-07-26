import { createHash } from "node:crypto";

import { SaberError } from "./errors.js";
import type { Capability } from "./models.js";

/** A deliberately small fetch boundary so tests never need network access. */
export type HttpRequestInit = {
  method: "GET" | "POST" | "PUT";
  headers: Readonly<Record<string, string>>;
  body?: string;
  redirect: "error";
};

export type HttpResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
};

export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export type HttpExecutionDependencies = {
  /** Values are read only at execute time; configuration stores names, never values. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: HttpFetch;
};

export type HttpTarget =
  | { type: "jira-issue"; key: string }
  | { type: "gitlab-merge-request"; project: string; iid: number }
  | {
      type: "gitlab-merge-request-list";
      project: string;
      sourceBranch: string;
      targetBranch?: string;
    }
  | { type: "gitlab-project"; project: string };

/** A validated plan is data only; this module deliberately exports no raw transport. */
export type PreparedHttpRequest = {
  connector: "jira" | "gitlab";
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: string;
  target: HttpTarget;
};

export type HttpActionPreview = {
  account:
    | {
        credentialVariable: "JIRA_API_TOKEN" | "GITLAB_API_TOKEN";
        identityVariable: "JIRA_ACCOUNT_ID" | "GITLAB_ACCOUNT_ID";
        identity: string;
        state: "declared-local-identity";
      }
    | {
        credentialVariable: "JIRA_API_TOKEN" | "GITLAB_API_TOKEN";
        state: "credential-read-at-execution";
      };
  target: {
    connector: "jira" | "gitlab";
    method: "GET" | "POST" | "PUT";
    path: string;
    resource: HttpTarget;
  };
  /** Exact request body shape, recursively redacted only for sensitive field names. */
  changes: JsonValue | null;
};

export type ResolvedHttpTarget = {
  /** Kept in memory for the gated caller; never serialized to preview output or records. */
  url: string;
  /** Safe, one-way binding of the normalized remote target. */
  destinationDigest: string;
  account?: {
    identityVariable: "JIRA_ACCOUNT_ID" | "GITLAB_ACCOUNT_ID";
    identity: string;
  };
};

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const controlCharacter = /[\u0000-\u001F\u007F]/u;
const descriptionControlCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const jiraKey = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]*$/u;
const gitlabPathSegment = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const jiraFieldName = /^[A-Za-z][A-Za-z0-9_]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= 100 &&
      entries.every(
        ([key, item]) =>
          key !== "__proto__" &&
          key !== "prototype" &&
          key !== "constructor" &&
          isJsonValue(item, depth + 1),
      )
    );
  }
  return false;
}

function requiredString(value: unknown, label: string, maximumLength = 255): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    controlCharacter.test(value)
  ) {
    throw new SaberError(`invalid ${label} payload`, 2);
  }
  return value;
}

function optionalDescription(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length > 10_000 ||
    descriptionControlCharacter.test(value)
  ) {
    throw new SaberError("invalid GitLab create payload", 2);
  }
  return value;
}

function requireJiraKey(value: unknown, label: string): string {
  const key = requiredString(value, label, 128);
  if (!jiraKey.test(key)) {
    throw new SaberError(`invalid ${label} payload`, 2);
  }
  return key;
}

function requireGitlabProject(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SaberError("invalid GitLab project payload", 2);
    }
    return String(value);
  }
  const project = requiredString(value, "GitLab project", 255);
  if (!project.split("/").every((segment) => gitlabPathSegment.test(segment))) {
    throw new SaberError("invalid GitLab project payload", 2);
  }
  return project;
}

function requireGitlabIid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SaberError("invalid GitLab merge request payload", 2);
  }
  return value as number;
}

function jiraReadRequest(payload: unknown): PreparedHttpRequest {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ["key"])) {
    throw new SaberError("invalid Jira read payload", 2);
  }
  const key = requireJiraKey(payload.key, "Jira read");
  return {
    connector: "jira",
    method: "GET",
    path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
    target: { type: "jira-issue", key },
  };
}

function jiraUpdateRequest(payload: unknown): PreparedHttpRequest {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ["key", "fields"])) {
    throw new SaberError("invalid Jira update payload", 2);
  }
  const key = requireJiraKey(payload.key, "Jira update");
  if (!isRecord(payload.fields) || Object.keys(payload.fields).length === 0) {
    throw new SaberError("invalid Jira update payload", 2);
  }
  for (const [field, value] of Object.entries(payload.fields)) {
    if (!jiraFieldName.test(field) || !isJsonValue(value)) {
      throw new SaberError("invalid Jira update payload", 2);
    }
  }
  return {
    connector: "jira",
    method: "PUT",
    path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
    body: JSON.stringify({ fields: payload.fields }),
    target: { type: "jira-issue", key },
  };
}

function gitlabReadRequest(payload: unknown): PreparedHttpRequest {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ["project", "iid", "sourceBranch", "targetBranch"])) {
    throw new SaberError("invalid GitLab merge request payload", 2);
  }
  const project = requireGitlabProject(payload.project);
  if (payload.iid !== undefined) {
    const iid = requireGitlabIid(payload.iid);
    return {
      connector: "gitlab",
      method: "GET",
      path: `/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`,
      target: { type: "gitlab-merge-request", project, iid },
    };
  }
  const sourceBranch = requiredString(payload.sourceBranch, "GitLab merge request", 255);
  const targetBranch =
    payload.targetBranch === undefined
      ? undefined
      : requiredString(payload.targetBranch, "GitLab merge request", 255);
  const query = new URLSearchParams({ state: "opened", source_branch: sourceBranch });
  if (targetBranch !== undefined) {
    query.set("target_branch", targetBranch);
  }
  return {
    connector: "gitlab",
    method: "GET",
    path: `/api/v4/projects/${encodeURIComponent(project)}/merge_requests?${query.toString()}`,
    target: { type: "gitlab-merge-request-list", project, sourceBranch, ...(targetBranch === undefined ? {} : { targetBranch }) },
  };
}

function gitlabCreateRequest(payload: unknown): PreparedHttpRequest {
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, [
      "project",
      "title",
      "sourceBranch",
      "targetBranch",
      "description",
      "removeSourceBranch",
    ])
  ) {
    throw new SaberError("invalid GitLab create payload", 2);
  }
  const project = requireGitlabProject(payload.project);
  const title = requiredString(payload.title, "GitLab create", 255);
  const sourceBranch = requiredString(payload.sourceBranch, "GitLab create", 255);
  const targetBranch = requiredString(payload.targetBranch, "GitLab create", 255);
  if (
    payload.removeSourceBranch !== undefined &&
    typeof payload.removeSourceBranch !== "boolean"
  ) {
    throw new SaberError("invalid GitLab create payload", 2);
  }
  const body: Record<string, JsonValue> = {
    title,
    source_branch: sourceBranch,
    target_branch: targetBranch,
  };
  const description = optionalDescription(payload.description);
  if (description !== undefined) {
    body.description = description;
  }
  if (payload.removeSourceBranch !== undefined) {
    body.remove_source_branch = payload.removeSourceBranch;
  }
  return {
    connector: "gitlab",
    method: "POST",
    path: `/api/v4/projects/${encodeURIComponent(project)}/merge_requests`,
    body: JSON.stringify(body),
    target: { type: "gitlab-project", project },
  };
}

function prepareRequest(capabilityId: string, payload: unknown): PreparedHttpRequest {
  switch (capabilityId) {
    case "jira.read":
      return jiraReadRequest(payload);
    case "jira.update":
      return jiraUpdateRequest(payload);
    case "gitlab.mr.read":
      return gitlabReadRequest(payload);
    case "gitlab.mr.create":
      return gitlabCreateRequest(payload);
    default:
      throw new SaberError(
        "this capability has no safe HTTP executor; L0/L1 may use native MCP and L2 requires an approved connector adapter",
        3,
      );
  }
}

export function expectedHttpEnvironmentNames(
  connector: "jira" | "gitlab",
): readonly [
  "JIRA_BASE_URL" | "GITLAB_BASE_URL",
  "JIRA_API_TOKEN" | "GITLAB_API_TOKEN",
  "JIRA_ACCOUNT_ID" | "GITLAB_ACCOUNT_ID",
] {
  return connector === "jira"
    ? ["JIRA_BASE_URL", "JIRA_API_TOKEN", "JIRA_ACCOUNT_ID"]
    : ["GITLAB_BASE_URL", "GITLAB_API_TOKEN", "GITLAB_ACCOUNT_ID"];
}

function safeHttpsBaseUrl(value: string, connector: "jira" | "gitlab"): URL {
  if (value !== value.trim() || value.length === 0 || value.length > 2_048 || controlCharacter.test(value)) {
    throw new SaberError(`connector ${connector} base URL is invalid`, 2);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SaberError(`connector ${connector} base URL is invalid`, 2);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new SaberError(
      `connector ${connector} base URL must be credential-free HTTPS without query or fragment`,
      2,
    );
  }
  const rawSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  try {
    if (
      rawSegments.some((segment) => {
        const decoded = decodeURIComponent(segment);
        return decoded === "." || decoded === ".." || controlCharacter.test(decoded);
      })
    ) {
      throw new SaberError(`connector ${connector} base URL is invalid`, 2);
    }
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      throw error;
    }
    throw new SaberError(`connector ${connector} base URL is invalid`, 2);
  }
  return url;
}

function endpointUrl(base: URL, path: string): string {
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/$/u, "");
  const endpoint = new URL(base.origin);
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : path.slice(queryIndex + 1);
  endpoint.pathname = `${basePath}${pathname}`;
  endpoint.search = query;
  return endpoint.toString();
}

function isKnownHttpCapability(capabilityId: string): boolean {
  return ["jira.read", "jira.update", "gitlab.mr.read", "gitlab.mr.create"].includes(
    capabilityId,
  );
}

/** Build only a fixed, reviewed HTTP request plan. It cannot make a network call. */
export function prepareHttpCapability(
  capability: Capability,
  payload: unknown,
): PreparedHttpRequest | undefined {
  if (!isKnownHttpCapability(capability.id)) {
    return undefined;
  }
  const request = prepareRequest(capability.id, payload);
  if (capability.connector !== request.connector) {
    throw new SaberError("capability connector does not match its approved HTTP executor", 2);
  }
  return request;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Resolve the non-secret base URL and, for L2, the declared visible account.
 * The caller must not print or persist `url`; `destinationDigest` binds the
 * preview to the exact endpoint and required account identity.
 */
export function resolveHttpTarget(
  request: PreparedHttpRequest,
  environment: Readonly<Record<string, string | undefined>>,
  requireAccount = false,
): ResolvedHttpTarget {
  const [baseName, , identityVariable] = expectedHttpEnvironmentNames(request.connector);
  const baseValue = environment[baseName];
  if (baseValue === undefined || baseValue.trim().length === 0) {
    throw new SaberError(
      `connector ${request.connector} is not configured; set ${baseName} and retry`,
      3,
    );
  }
  const base = safeHttpsBaseUrl(baseValue, request.connector);
  const url = endpointUrl(base, request.path);
  if (!requireAccount) {
    return {
      url,
      destinationDigest: digest(`saber-http-target-v1\u0000${request.connector}\u0000${url}`),
    };
  }
  const identity = environment[identityVariable];
  if (
    identity === undefined ||
    identity.length === 0 ||
    identity.length > 320 ||
    identity.trim() !== identity ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(identity)
  ) {
    throw new SaberError(
      `connector ${request.connector} is not configured; set ${identityVariable} to the visible account identity and retry`,
      3,
    );
  }
  return {
    url,
    destinationDigest: digest(
      `saber-http-target-v1\u0000${request.connector}\u0000${url}\u0000${identityVariable}\u0000${identity}`,
    ),
    account: { identityVariable, identity },
  };
}

function isSensitivePreviewKey(key: string): boolean {
  return /token|password|authorization|api.?key|secret|credential/iu.test(key);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|password|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    );
}

function redactPreviewValue(value: JsonValue, key?: string): JsonValue {
  if (key !== undefined && isSensitivePreviewKey(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPreviewValue(item));
  }
  if (isRecord(value)) {
    const redacted: Record<string, JsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (isJsonValue(childValue)) {
        redacted[childKey] = redactPreviewValue(childValue, childKey);
      }
    }
    return redacted;
  }
  return typeof value === "string" ? redactSensitiveText(value) : value;
}

/** Create a human-readable, credential-free preview from an already validated plan. */
export function describeHttpRequest(
  request: PreparedHttpRequest,
  account?: ResolvedHttpTarget["account"],
): HttpActionPreview {
  const [, credentialVariable] = expectedHttpEnvironmentNames(request.connector);
  let changes: JsonValue | null = null;
  if (request.body !== undefined) {
    const parsed = JSON.parse(request.body) as unknown;
    if (!isJsonValue(parsed)) {
      throw new SaberError("could not prepare a safe action preview", 2);
    }
    changes = redactPreviewValue(parsed);
  }
  return {
    account:
      account === undefined
        ? { credentialVariable, state: "credential-read-at-execution" }
        : {
            credentialVariable,
            identityVariable: account.identityVariable,
            identity: account.identity,
            state: "declared-local-identity",
          },
    target: {
      connector: request.connector,
      method: request.method,
      path: request.path,
      resource: request.target,
    },
    changes,
  };
}

/** Parse connector JSON while applying the same credential redaction used by previews. */
export function parseHttpResponseBody(text: string): JsonValue | null {
  if (text.length > 1_000_000) {
    throw new SaberError("connector response is too large", 2);
  }
  if (text.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SaberError("connector returned invalid JSON", 2);
  }
  if (!isJsonValue(parsed)) {
    throw new SaberError("connector returned unsupported JSON", 2);
  }
  return redactPreviewValue(parsed);
}
