import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { SaberError } from "./errors.js";
import { resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import {
  describeHttpRequest,
  expectedHttpEnvironmentNames,
  type HttpExecutionDependencies,
  type HttpActionPreview,
  type HttpFetch,
  type HttpRequestInit,
  type HttpResponse,
  type PreparedHttpRequest,
  parseHttpResponseBody,
  prepareHttpCapability,
  resolveHttpTarget,
} from "./http.js";
import type { Capability, ConnectorConfig, RepositoryConfig, RiskLevel } from "./models.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type PreviewRecord = {
  schemaVersion: 1;
  token: string;
  capabilityId: string;
  payloadDigest: string;
  targetDigest: string;
  state: "ready" | "consumed";
};

export type ActionPreview = Omit<PreviewRecord, "state" | "targetDigest"> & {
  risk: RiskLevel;
  state: "previewed";
  /** Present only for reviewed Jira/GitLab mappings; never contains credential values or base URLs. */
  operation?: HttpActionPreview;
};

export type ActionExecution = {
  state: "executed";
  capabilityId: string;
  risk: RiskLevel;
  connector: "jira" | "gitlab";
  method: "GET" | "POST" | "PUT";
  path: string;
  status: number;
  data: import("./http.js").JsonValue | null;
};

export type ActionExecutionDependencies = HttpExecutionDependencies & {
  /** Required only for L2 actions and never sent to the remote connector. */
  confirmation?: string;
};

export type ActionPreviewDependencies = {
  /** Only non-secret BASE_URL is read here so the preview binds the destination. */
  env?: Readonly<Record<string, string | undefined>>;
};

const previewDirectorySegments = [".saber", "runtime", "action-previews"] as const;
const maxPayloadBytes = 1_000_000;
const fixedRemoteWriteCapabilities = new Set([
  "jira.update",
  "gitlab.mr.create",
  "mysql.write",
  "idea.command.execute",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** The trusted HTTP mapping cannot be relaxed by changing declarative risk text. */
function assertActionRiskPolicy(capability: Capability): void {
  if (capability.risk === "L3") {
    throw new SaberError("L3 actions are permanently forbidden", 3);
  }
  if (
    fixedRemoteWriteCapabilities.has(capability.id) &&
    (capability.risk !== "L2" || capability.kind !== "action")
  ) {
    throw new SaberError("configured HTTP writes must use risk level L2 and kind action", 2);
  }
}

function canonicalize(value: unknown, ancestors: WeakSet<object>, depth: number): string {
  if (depth > 32) {
    throw new SaberError("payload is too deeply nested", 2);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SaberError("payload must contain only finite JSON numbers", 2);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new SaberError("payload must not contain cycles", 2);
    }
    ancestors.add(value);
    try {
      return `[${value.map((item) => canonicalize(item, ancestors, depth + 1)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) {
      throw new SaberError("payload must not contain cycles", 2);
    }
    ancestors.add(value);
    try {
      const keys = Object.keys(value).sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors, depth + 1)}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new SaberError("payload must be valid JSON data", 2);
}

/** Return a stable JSON representation without trusting insertion order or object serialization hooks. */
export function canonicalizeJsonPayload(payload: unknown): string {
  return canonicalize(payload, new WeakSet<object>(), 0);
}

/** Bind the confirmation value to the exact capability and canonical payload. */
export function calculatePreviewToken(
  capabilityId: string,
  canonicalPayload: string,
  targetDigest = "no-http-target",
): string {
  return digest(
    `saber-action-preview-v1\u0000${capabilityId}\u0000${canonicalPayload}\u0000${targetDigest}`,
  );
}

type PreparedActionContext = {
  targetDigest: string;
  request?: PreparedHttpRequest;
  operation?: HttpActionPreview;
  targetUrl?: string;
};

/**
 * Resolve an approved HTTP target before confirmation using BASE_URL only.
 * API tokens are deliberately not consulted until after the L2 gate.
 */
function prepareActionContext(
  capability: Capability,
  payload: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): PreparedActionContext {
  const request = prepareHttpCapability(capability, payload);
  if (request === undefined) {
    return { targetDigest: "no-http-target" };
  }
  const resolved = resolveHttpTarget(request, environment);
  return {
    targetDigest: resolved.destinationDigest,
    request,
    operation: describeHttpRequest(request),
    targetUrl: resolved.url,
  };
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

/**
 * The action runtime is owned by Saber. Refuse every symlink and non-directory
 * component so a local preview cannot be redirected outside the workspace.
 */
async function previewDirectory(
  repositoryRoot: string,
  create: boolean,
): Promise<string | undefined> {
  try {
    // Existing parents are canonicalized before any mkdir; this catches an
    // escaping intermediate link even when the final directory is absent.
    resolveWithinRoot(repositoryRoot, previewDirectorySegments.join("/"));
  } catch {
    throw new SaberError("action preview storage is unsafe", 3);
  }

  let current = resolve(repositoryRoot);
  for (const segment of previewDirectorySegments) {
    current = join(current, segment);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SaberError("action preview storage is unsafe", 3);
      }
    } catch (error: unknown) {
      if (error instanceof SaberError) {
        throw error;
      }
      if (!isMissingPath(error)) {
        throw new SaberError("action preview storage is unavailable", 3);
      }
      if (!create) {
        return undefined;
      }
      try {
        await mkdir(current);
        const status = await lstat(current);
        if (status.isSymbolicLink() || !status.isDirectory()) {
          throw new SaberError("action preview storage is unsafe", 3);
        }
      } catch (mkdirError: unknown) {
        if (mkdirError instanceof SaberError) {
          throw mkdirError;
        }
        throw new SaberError("action preview storage is unavailable", 3);
      }
    }
  }
  return current;
}

function previewRecordFileName(token: string): string {
  // Preview tokens are API values, whereas storage names must also work on Windows.
  return `${token.replace(/^sha256:/u, "sha256-")}.json`;
}

function consumedPreviewRecordFileName(token: string): string {
  return `${previewRecordFileName(token)}.consumed`;
}

function asPreviewRecord(value: unknown): PreviewRecord | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 6) {
    return undefined;
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.token !== "string" ||
    typeof value.capabilityId !== "string" ||
    typeof value.payloadDigest !== "string" ||
    typeof value.targetDigest !== "string" ||
    (value.state !== "ready" && value.state !== "consumed")
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    token: value.token,
    capabilityId: value.capabilityId,
    payloadDigest: value.payloadDigest,
    targetDigest: value.targetDigest,
    state: value.state,
  };
}

function samePreview(record: PreviewRecord, expected: PreviewRecord): boolean {
  return (
    record.schemaVersion === expected.schemaVersion &&
    record.token === expected.token &&
    record.capabilityId === expected.capabilityId &&
    record.payloadDigest === expected.payloadDigest &&
    record.targetDigest === expected.targetDigest
  );
}

function previewRecordContent(record: PreviewRecord): string {
  return `${JSON.stringify(record)}\n`;
}

async function readPreviewRecord(path: string): Promise<PreviewRecord | undefined> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new SaberError("action preview storage is unsafe", 3);
    }
    const record = asPreviewRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (record === undefined) {
      throw new SaberError("action preview storage is unsafe", 3);
    }
    return record;
  } catch (error: unknown) {
    if (error instanceof SaberError) {
      throw error;
    }
    if (isMissingPath(error)) {
      return undefined;
    }
    throw new SaberError("action preview storage is unavailable", 3);
  }
}

async function persistPreviewRecord(
  repositoryRoot: string,
  record: PreviewRecord,
): Promise<void> {
  const directory = await previewDirectory(repositoryRoot, true);
  if (directory === undefined) {
    throw new SaberError("action preview storage is unavailable", 3);
  }
  const path = join(directory, previewRecordFileName(record.token));
  const existing = await readPreviewRecord(path);
  if (existing !== undefined) {
    if (!samePreview(existing, record)) {
      throw new SaberError("action preview storage is unsafe", 3);
    }
    return;
  }

  try {
    // The exclusive create gives concurrent previews one stable record without
    // a separate lock file that could survive a process crash.
    await writeFile(path, previewRecordContent(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: unknown) {
    if (!isMissingPath(error) && typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
      const concurrent = await readPreviewRecord(path);
      if (concurrent !== undefined && samePreview(concurrent, record)) {
        return;
      }
    }
    throw new SaberError("action preview storage is unavailable", 3);
  }
}

function confirmationRecoveryError(): SaberError {
  return new SaberError(
    "L2 action is paused: create a preview for the same capability and payload, then rerun with its exact --confirm token (recovery: saber action preview <capability> --payload <json-file>)",
    3,
  );
}

async function consumeExactPreviewRecord(
  repositoryRoot: string,
  record: PreviewRecord,
): Promise<boolean> {
  let directory: string | undefined;
  try {
    directory = await previewDirectory(repositoryRoot, false);
  } catch {
    return false;
  }
  if (directory === undefined) {
    return false;
  }
  const readyPath = join(directory, previewRecordFileName(record.token));
  const consumedPath = join(directory, consumedPreviewRecordFileName(record.token));
  const existing = await readPreviewRecord(readyPath);
  if (existing === undefined || existing.state !== "ready" || !samePreview(existing, record)) {
    return false;
  }

  try {
    // A same-directory rename is atomic. Exactly one caller can move the ready
    // record to its consumed name and proceed to the network transport.
    await rename(readyPath, consumedPath);
    return true;
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return false;
    }
    return false;
  }
}

/** Read a repository-local JSON file without permitting traversal or symbolic links. */
export async function loadActionPayload(
  repositoryRoot: string,
  relativePayloadPath: string,
): Promise<unknown> {
  let canonicalPath: string;
  try {
    if (relativePayloadPath.length === 0) {
      throw new SaberError("payload file is invalid", 2);
    }
    resolveWithinRoot(repositoryRoot, relativePayloadPath);
    const lexicalPath = resolve(repositoryRoot, relativePayloadPath);
    const status = await lstat(lexicalPath);
    if (status.isSymbolicLink() || !status.isFile() || status.size > maxPayloadBytes) {
      throw new SaberError("payload file is invalid", 2);
    }
    canonicalPath = await resolveExistingPathWithinRoot(repositoryRoot, relativePayloadPath);
  } catch {
    throw new SaberError("payload file must be a regular JSON file within the repository", 2);
  }
  let text: string;
  try {
    text = await readFile(canonicalPath, "utf8");
  } catch {
    throw new SaberError("payload file must be a regular JSON file within the repository", 2);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SaberError("payload file must contain valid JSON", 2);
  }
}

function configuredHttpConnector(
  config: RepositoryConfig,
  capability: Capability,
  request: PreparedHttpRequest,
): ConnectorConfig {
  if (capability.connector === undefined) {
    throw new SaberError(
      "this capability has no executable connector; use its approved tool adapter",
      3,
    );
  }
  const connector = config.connectors.find((candidate) => candidate.id === capability.connector);
  if (connector === undefined || connector.kind !== "http") {
    throw new SaberError(
      "this capability is not backed by an approved HTTP connector; use its native MCP tool",
      3,
    );
  }
  const [baseName, tokenName] = expectedHttpEnvironmentNames(request.connector);
  if (
    !connector.provides.includes(capability.id) ||
    !connector.requiredEnv.includes(baseName) ||
    !connector.requiredEnv.includes(tokenName)
  ) {
    throw new SaberError("connector capability mapping is invalid", 2);
  }
  return connector;
}

function readApiToken(
  connector: "jira" | "gitlab",
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const [, tokenName] = expectedHttpEnvironmentNames(connector);
  const token = environment[tokenName];
  if (token === undefined || token.trim().length === 0) {
    throw new SaberError(
      `connector ${connector} is not configured; set ${tokenName} and retry`,
      3,
    );
  }
  if (token !== token.trim() || /[\u0000-\u001F\u007F]/u.test(token) || token.length > 8_192) {
    throw new SaberError(`connector ${connector} API token is invalid`, 2);
  }
  return token;
}

const defaultFetch: HttpFetch = async (url, init) => {
  const response = await globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: init.redirect,
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: () => response.text(),
  };
};

/** Raw network transport stays private to this module and is reachable only after risk gating. */
async function executePreparedHttpRequest(
  config: RepositoryConfig,
  capability: Capability,
  request: PreparedHttpRequest,
  targetUrl: string,
  dependencies: ActionExecutionDependencies,
): Promise<Omit<ActionExecution, "state" | "capabilityId" | "risk">> {
  configuredHttpConnector(config, capability, request);
  const environment = dependencies.env ?? process.env;
  const token = readApiToken(request.connector, environment);
  const init: HttpRequestInit = {
    method: request.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "error",
  };
  const fetchImplementation = dependencies.fetch ?? defaultFetch;
  let response: HttpResponse;
  try {
    response = await fetchImplementation(targetUrl, init);
  } catch {
    throw new SaberError(
      `${request.connector === "jira" ? "Jira" : "GitLab"} request failed; check connector configuration and network access`,
    );
  }
  if (!response.ok) {
    if (request.connector === "gitlab" && capability.id === "gitlab.mr.create" && response.status === 409) {
      throw new SaberError(
        "GitLab MR creation conflicted; recover with gitlab.mr.read using project, sourceBranch, and targetBranch",
        3,
      );
    }
    throw new SaberError(
      `${request.connector === "jira" ? "Jira" : "GitLab"} request failed with HTTP ${response.status}`,
    );
  }
  const data = parseHttpResponseBody(await response.text());
  return {
    connector: request.connector,
    method: request.method,
    path: request.path,
    status: response.status,
    data,
  };
}

/** Create a local-only preview that binds the canonical payload and non-secret remote target. */
export async function createActionPreview(
  repositoryRoot: string,
  capability: Capability,
  payload: unknown,
  dependencies: ActionPreviewDependencies = {},
): Promise<ActionPreview> {
  assertActionRiskPolicy(capability);
  const canonicalPayload = canonicalizeJsonPayload(payload);
  const context = prepareActionContext(capability, payload, dependencies.env ?? process.env);
  const record: PreviewRecord = {
    schemaVersion: 1,
    token: calculatePreviewToken(capability.id, canonicalPayload, context.targetDigest),
    capabilityId: capability.id,
    payloadDigest: digest(canonicalPayload),
    targetDigest: context.targetDigest,
    state: "ready",
  };
  await persistPreviewRecord(repositoryRoot, record);
  return {
    schemaVersion: record.schemaVersion,
    token: record.token,
    capabilityId: record.capabilityId,
    payloadDigest: record.payloadDigest,
    risk: capability.risk,
    state: "previewed",
    ...(context.operation === undefined ? {} : { operation: context.operation }),
  };
}

/**
 * Enforce risk policy before entering the connector. L2 runs only after the
 * exact local preview record and caller confirmation both match.
 */
export async function executeAction(
  repositoryRoot: string,
  config: RepositoryConfig,
  capability: Capability,
  payload: unknown,
  dependencies: ActionExecutionDependencies = {},
): Promise<ActionExecution> {
  assertActionRiskPolicy(capability);

  const canonicalPayload = canonicalizeJsonPayload(payload);
  const environment = dependencies.env ?? process.env;
  const context = prepareActionContext(capability, payload, environment);
  const record: PreviewRecord = {
    schemaVersion: 1,
    token: calculatePreviewToken(capability.id, canonicalPayload, context.targetDigest),
    capabilityId: capability.id,
    payloadDigest: digest(canonicalPayload),
    targetDigest: context.targetDigest,
    state: "ready",
  };
  if (
    capability.risk === "L2" &&
    (dependencies.confirmation !== record.token ||
      !(await consumeExactPreviewRecord(repositoryRoot, record)))
  ) {
    throw confirmationRecoveryError();
  }
  if (context.request === undefined || context.targetUrl === undefined) {
    throw new SaberError(
      "this capability has no safe HTTP executor; use its native MCP tool or add an approved connector adapter",
      3,
    );
  }
  // Re-resolve immediately before transport so an environment change cannot redirect an approved batch.
  const currentTarget = resolveHttpTarget(context.request, environment);
  if (currentTarget.destinationDigest !== record.targetDigest) {
    throw confirmationRecoveryError();
  }
  const execution = await executePreparedHttpRequest(
    config,
    capability,
    context.request,
    currentTarget.url,
    dependencies,
  );
  return {
    state: "executed",
    capabilityId: capability.id,
    risk: capability.risk,
    ...execution,
  };
}
