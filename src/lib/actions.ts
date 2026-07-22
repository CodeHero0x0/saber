import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join, resolve } from "node:path";

import { SaberError } from "./errors.js";
import { resolveExistingPathWithinRoot, resolveWithinRoot } from "./files.js";
import { isSafeExternalAssetSource } from "./validation.js";
import { runSafeProcess, type SafeProcessCommand, type SafeProcessRunner } from "./git.js";
import { redactExternalAssetSource } from "./external-assets.js";
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
import { connectMcpServer, type McpClientLike } from "./mcp/client.js";
import { fingerprintMcpValue, resolveMcpRuntime, type McpRuntimeDescriptor } from "./mcp/runtime.js";
import type { Capability, ConnectorConfig, RepositoryConfig, RiskLevel } from "./models.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type PreviewRecord = {
  schemaVersion: 2;
  token: string;
  nonce: string;
  capabilityId: string;
  payloadDigest: string;
  targetDigest: string;
  state: "ready";
};

export type ActionPreview = Omit<PreviewRecord, "state" | "targetDigest" | "nonce"> & {
  risk: RiskLevel;
  state: "previewed";
  /** Reviewed connector operation; never contains credential values or private service base URLs. */
  operation?: HttpActionPreview | GitPushActionPreview | McpActionPreview;
};

export type ActionExecution = {
  state: "executed" | "uncertain";
  capabilityId: string;
  risk: RiskLevel;
  connector: "jira" | "gitlab" | "git" | "mcp";
  method: "GET" | "POST" | "PUT" | "PUSH" | "CALL";
  path: string;
  status: number;
  data: import("./http.js").JsonValue | null;
  reconciliation?: {
    state: "reconciled" | "observed" | "unavailable";
    capabilityId?: string;
    tool?: string;
    data?: import("./http.js").JsonValue | null;
  };
};

export type ActionExecutionDependencies = HttpExecutionDependencies & {
  /** Required only for L2 actions and never sent to the remote connector. */
  confirmation?: string;
  runner?: SafeProcessRunner;
  connectMcp?: typeof connectMcpServer;
};

export type ActionPreviewDependencies = {
  /** Preview reads only non-secret destination/account metadata; API tokens stay execution-only. */
  env?: Readonly<Record<string, string | undefined>>;
  config?: RepositoryConfig;
  runner?: SafeProcessRunner;
};

const previewDirectorySegments = [".saber", "runtime", "action-previews"] as const;
const maxPayloadBytes = 1_000_000;
const fixedRemoteWriteCapabilities = new Set([
  "jira.update",
  "gitlab.mr.create",
  "mysql.write",
  "idea.command.execute",
  "git.push",
]);

type GitPushActionPreview = {
  account: {
    credentialVariable: "local-git-credential-helper";
    identityVariable: "GIT_PUSH_ACCOUNT_ID";
    identity: string;
    state: "declared-local-identity";
  };
  target: {
    connector: "git";
    method: "PUSH";
    path: string;
    resource: {
      project: string;
      remote: string;
      remoteSource: string;
      branch: string;
    };
  };
  changes: { commit: string };
};

type McpActionPreview = {
  account: {
    credentialVariable: "configured MCP environment references";
    state: "resolved-at-execution";
  };
  target: {
    connector: "mcp";
    method: "CALL";
    path: string;
    resource: { server: string; tool: string; transport: "stdio" | "http"; target: string };
  };
  changes: { arguments: JsonValue };
};

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
    throw new SaberError("configured external writes must use risk level L2 and kind action", 2);
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

function calculatePreviewTokenFromDigests(
  capabilityId: string,
  payloadDigest: string,
  targetDigest: string,
  nonce: string,
): string {
  return digest(
    `saber-action-preview-v2\u0000${capabilityId}\u0000${payloadDigest}\u0000${targetDigest}\u0000${nonce}`,
  );
}

/** Bind a single-use confirmation value to the exact capability, payload, target, and nonce. */
export function calculatePreviewToken(
  capabilityId: string,
  canonicalPayload: string,
  nonce: string,
  targetDigest = "no-http-target",
): string {
  return calculatePreviewTokenFromDigests(
    capabilityId,
    digest(canonicalPayload),
    targetDigest,
    nonce,
  );
}

type PreparedActionContext = {
  targetDigest: string;
  request?: PreparedHttpRequest;
  operation?: HttpActionPreview | GitPushActionPreview | McpActionPreview;
  targetUrl?: string;
  gitPush?: PreparedGitPush;
  mcp?: PreparedMcp;
};

type PreparedGitPush = {
  project: string;
  projectPath: string;
  remote: string;
  branch: string;
  commit: string;
  remoteSource: string;
};

type PreparedMcp = {
  descriptor: McpRuntimeDescriptor;
  serverId: string;
  toolName: string;
  readToolName?: string;
  readCapabilityId?: string;
};

/**
 * Resolve an approved HTTP target before confirmation using BASE_URL only.
 * API tokens are deliberately not consulted until after the L2 gate.
 */
function requiredGitPushString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new SaberError(`invalid git.push ${label}`, 2);
  }
  return value;
}

function readGitPushAccount(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment.GIT_PUSH_ACCOUNT_ID;
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 320 ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    throw new SaberError(
      "connector git is not configured; set GIT_PUSH_ACCOUNT_ID to the visible account identity and retry",
      3,
    );
  }
  return value;
}

function safeGitOutput(result: { exitCode: number; stdout?: string }, label: string): string {
  const value = result.stdout?.trim();
  if (result.exitCode !== 0 || value === undefined || value.length === 0) {
    throw new SaberError(`could not inspect git.push ${label}`, 2);
  }
  return value;
}

async function prepareGitPushContext(
  repositoryRoot: string,
  config: RepositoryConfig | undefined,
  capability: Capability,
  payload: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  runner: SafeProcessRunner,
): Promise<PreparedActionContext> {
  if (config === undefined) {
    throw new SaberError("git.push preview requires repository configuration", 2);
  }
  configuredGitConnector(config, capability);
  if (!isRecord(payload) || !hasOnlyKeys(payload, ["project", "remote", "branch"])) {
    throw new SaberError("invalid git.push payload", 2);
  }
  const projectName = requiredGitPushString(payload.project, "project");
  const remote = requiredGitPushString(payload.remote, "remote");
  const branch = requiredGitPushString(payload.branch, "branch");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(remote)) {
    throw new SaberError("invalid git.push remote", 2);
  }
  const project = config.workspace.projects.find((candidate) => candidate.name === projectName);
  if (project === undefined) {
    throw new SaberError(`unknown git.push project ${projectName}`, 2);
  }
  let projectPath: string;
  try {
    projectPath = await resolveExistingPathWithinRoot(repositoryRoot, project.path);
    if (!(await lstat(projectPath)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new SaberError(`git.push project ${projectName} is missing`, 2);
  }
  const branchCheck = await runner({
    program: "git",
    args: ["check-ref-format", "--branch", branch],
    cwd: projectPath,
  });
  if (branchCheck.exitCode !== 0) {
    throw new SaberError("invalid git.push branch", 2);
  }
  const remoteSource = safeGitOutput(
    await runner({
      program: "git",
      args: ["remote", "get-url", "--push", "--all", remote],
      cwd: projectPath,
      captureStdout: true,
    }),
    "remote",
  );
  if (remoteSource.split(/\r?\n/u).length !== 1) {
    throw new SaberError("git.push remote must resolve to exactly one push URL", 2);
  }
  if (!isSafeExternalAssetSource(remoteSource)) {
    throw new SaberError("git.push remote must be a credential-free HTTPS or SSH URL", 2);
  }
  const commit = safeGitOutput(
    await runner({
      program: "git",
      args: ["rev-parse", "--verify", `refs/heads/${branch}`],
      cwd: projectPath,
      captureStdout: true,
    }),
    "commit",
  );
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(commit)) {
    throw new SaberError("git.push commit is invalid", 2);
  }
  const account = readGitPushAccount(environment);
  const gitPush: PreparedGitPush = {
    project: projectName,
    projectPath,
    remote,
    branch,
    commit: commit.toLowerCase(),
    remoteSource,
  };
  const targetDigest = digest(
    `saber-git-push-v1\u0000${projectName}\u0000${project.path}\u0000${remote}\u0000${remoteSource}\u0000${branch}\u0000${gitPush.commit}\u0000${account}`,
  );
  return {
    targetDigest,
    gitPush,
    operation: {
      account: {
        credentialVariable: "local-git-credential-helper",
        identityVariable: "GIT_PUSH_ACCOUNT_ID",
        identity: account,
        state: "declared-local-identity",
      },
      target: {
        connector: "git",
        method: "PUSH",
        path: project.path,
        resource: {
          project: projectName,
          remote,
          remoteSource: redactExternalAssetSource(remoteSource),
          branch,
        },
      },
      changes: { commit: gitPush.commit },
    },
  };
}

function mcpServers(config: RepositoryConfig): RepositoryConfig["mcp"]["servers"] {
  return [
    ...(config.mcp?.servers ?? []),
    ...(config.local?.mcp?.servers ?? []),
  ];
}

function isSensitiveMcpKey(key: string): boolean {
  return /(?:token|secret|password|authorization|credential|api[-_]?key)/iu.test(key);
}

function collectSensitiveMcpStrings(value: JsonValue, key?: string, found = new Set<string>()): Set<string> {
  if (key !== undefined && isSensitiveMcpKey(key) && typeof value === "string" && value.length > 0) {
    found.add(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveMcpStrings(item, undefined, found);
  } else if (isRecord(value)) {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      collectSensitiveMcpStrings(entryValue as JsonValue, entryKey, found);
    }
  }
  return found;
}

const sensitiveMcpAssignmentName = String.raw`(?:[A-Za-z0-9_-]*(?:api[-_]?key|authorization|credential|password|passwd|pwd|secret|token)[A-Za-z0-9_-]*|api key)`;

function redactEmbeddedMcpSecrets(value: string): string {
  const authorizationScheme = /\b([A-Za-z0-9_-]*authorization[A-Za-z0-9_-]*\b\s*(?:=|:)\s*)(?:Bearer|Basic)\s+[^\s&,;]+/giu;
  const quotedAssignment = new RegExp(
    String.raw`(\b${sensitiveMcpAssignmentName}\b\s*(?:=|:)\s*)(["'])([^"']*)(["'])`,
    "giu",
  );
  const unquotedAssignment = new RegExp(
    String.raw`(\b${sensitiveMcpAssignmentName}\b\s*(?:=|:)\s*)(?:Bearer\s+)?([^\s&,;]+)`,
    "giu",
  );
  return value
    .replace(authorizationScheme, "$1[REDACTED]")
    .replace(quotedAssignment, (_match, prefix: string, quote: string) =>
      `${prefix}${quote}[REDACTED]${quote}`)
    .replace(unquotedAssignment, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s&,;]+/giu, "Bearer [REDACTED]");
}

function redactMcpValue(value: JsonValue, secrets: ReadonlySet<string>, key?: string): JsonValue {
  if (
    key !== undefined &&
    isSensitiveMcpKey(key)
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
    return redactEmbeddedMcpSecrets(redacted);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMcpValue(item, secrets));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactMcpValue(entryValue as JsonValue, secrets, entryKey),
      ]),
    ) as JsonValue;
  }
  return value;
}

function normalizedMcpArguments(payload: unknown): JsonValue {
  if (!isRecord(payload)) {
    throw new SaberError("MCP action arguments must be a JSON object", 2);
  }
  return JSON.parse(canonicalizeJsonPayload(payload)) as JsonValue;
}

function mcpConfigDigest(config: RepositoryConfig): string {
  return fingerprintMcpValue({
    capabilities: config.capabilities,
    mcp: config.mcp,
    localMcp: config.local?.mcp,
    selectedTeamServers: config.local?.extensions?.mcpServers,
  });
}

function mcpActionContext(
  repositoryRoot: string,
  config: RepositoryConfig | undefined,
  capability: Capability,
  payload: unknown,
): PreparedActionContext | undefined {
  if (config === undefined) return undefined;
  const resolved = resolveMcpRuntime(repositoryRoot, config, {
    tool: config.workspace.tools.default,
    target: "workspace",
    capabilities: [capability.id],
  });
  const mappings = resolved.descriptors.flatMap((descriptor) =>
    descriptor.tools
      .filter((tool) => tool.capability === capability.id)
      .map((tool) => ({ descriptor, tool })),
  );
  if (mappings.length === 0) return undefined;
  if (capability.risk !== "L2" || capability.kind !== "action") {
    throw new SaberError("use the native L0/L1 MCP tool directly", 2);
  }
  if (mappings.length !== 1) {
    throw new SaberError("capability must have exactly one MCP server/tool mapping", 2);
  }

  const mapping = mappings[0]!;
  const server = mcpServers(config).find(
    (candidate) => candidate.id === mapping.descriptor.server.id,
  );
  if (server === undefined) {
    throw new SaberError("MCP action mapping could not be materialized", 2);
  }
  const configDigest = mcpConfigDigest(config);
  const readMappings = server.tools.filter((tool) => {
    const mappedCapability = config.capabilities.find((candidate) => candidate.id === tool.capability);
    return mappedCapability?.kind === "read" && mappedCapability.risk === "L0";
  });
  const readToolName = readMappings.length === 1 ? readMappings[0]!.name : undefined;
  const readCapabilityId = readMappings.length === 1 ? readMappings[0]!.capability : undefined;
  const targetDigest = fingerprintMcpValue({
    server,
    tool: mapping.tool,
    target: "workspace",
    configDigest,
  });
  const argumentsValue = normalizedMcpArguments(payload);
  const sensitiveValues = collectSensitiveMcpStrings(argumentsValue);
  return {
    targetDigest,
    mcp: {
      descriptor: mapping.descriptor,
      serverId: server.id,
      toolName: mapping.tool.name,
      ...(readToolName === undefined ? {} : { readToolName }),
      ...(readCapabilityId === undefined ? {} : { readCapabilityId }),
    },
    operation: {
      account: {
        credentialVariable: "configured MCP environment references",
        state: "resolved-at-execution",
      },
      target: {
        connector: "mcp",
        method: "CALL",
        path: `${server.id}/${mapping.tool.name}`,
        resource: {
          server: server.id,
          tool: mapping.tool.name,
          transport: server.transport,
          target: "workspace",
        },
      },
      changes: { arguments: redactMcpValue(argumentsValue, sensitiveValues) },
    },
  };
}

async function prepareActionContext(
  repositoryRoot: string,
  config: RepositoryConfig | undefined,
  capability: Capability,
  payload: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  runner: SafeProcessRunner,
): Promise<PreparedActionContext> {
  const mcpContext = mcpActionContext(repositoryRoot, config, capability, payload);
  if (mcpContext !== undefined) return mcpContext;
  if (capability.id === "git.push") {
    return prepareGitPushContext(
      repositoryRoot,
      config,
      capability,
      payload,
      environment,
      runner,
    );
  }
  const request = prepareHttpCapability(capability, payload);
  if (request === undefined) {
    return { targetDigest: "no-http-target" };
  }
  const resolved = resolveHttpTarget(request, environment, capability.risk === "L2");
  return {
    targetDigest: resolved.destinationDigest,
    request,
    operation: describeHttpRequest(request, resolved.account),
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
  if (!isRecord(value) || Object.keys(value).length !== 7) {
    return undefined;
  }
  if (
    value.schemaVersion !== 2 ||
    typeof value.token !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.token) ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.nonce) ||
    typeof value.capabilityId !== "string" ||
    typeof value.payloadDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.payloadDigest) ||
    typeof value.targetDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.targetDigest) ||
    value.state !== "ready"
  ) {
    return undefined;
  }
  const record: PreviewRecord = {
    schemaVersion: 2,
    token: value.token,
    nonce: value.nonce,
    capabilityId: value.capabilityId,
    payloadDigest: value.payloadDigest,
    targetDigest: value.targetDigest,
    state: value.state,
  };
  if (
    record.token !== calculatePreviewTokenFromDigests(
      record.capabilityId,
      record.payloadDigest,
      record.targetDigest,
      record.nonce,
    )
  ) {
    return undefined;
  }
  return record;
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
  const consumedPath = join(directory, consumedPreviewRecordFileName(record.token));
  if (
    (await readPreviewRecord(path)) !== undefined ||
    (await readPreviewRecord(consumedPath)) !== undefined
  ) {
    throw new SaberError("action preview storage is unsafe", 3);
  }

  try {
    await writeFile(path, previewRecordContent(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: unknown) {
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
  token: string,
  expected: Pick<PreviewRecord, "capabilityId" | "payloadDigest" | "targetDigest">,
): Promise<boolean> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(token)) {
    return false;
  }
  let directory: string | undefined;
  try {
    directory = await previewDirectory(repositoryRoot, false);
  } catch {
    return false;
  }
  if (directory === undefined) {
    return false;
  }
  const readyPath = join(directory, previewRecordFileName(token));
  const consumedPath = join(directory, consumedPreviewRecordFileName(token));
  const existing = await readPreviewRecord(readyPath);
  if (
    existing === undefined ||
    existing.token !== token ||
    existing.capabilityId !== expected.capabilityId ||
    existing.payloadDigest !== expected.payloadDigest ||
    existing.targetDigest !== expected.targetDigest
  ) {
    return false;
  }

  try {
    // Creating the tombstone is exclusive on every supported platform; unlike
    // rename, it can never replace an already-consumed confirmation record.
    await link(readyPath, consumedPath);
    await unlink(readyPath);
    return true;
  } catch {
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
  const [baseName, tokenName, accountName] = expectedHttpEnvironmentNames(request.connector);
  if (
    !connector.provides.includes(capability.id) ||
    !connector.requiredEnv.includes(baseName) ||
    !connector.requiredEnv.includes(tokenName) ||
    (capability.risk === "L2" && !connector.requiredEnv.includes(accountName))
  ) {
    throw new SaberError("connector capability mapping is invalid", 2);
  }
  return connector;
}

function configuredGitConnector(
  config: RepositoryConfig,
  capability: Capability,
): ConnectorConfig {
  if (capability.connector === undefined) {
    throw new SaberError("git.push has no configured connector", 2);
  }
  const connector = config.connectors.find((candidate) => candidate.id === capability.connector);
  if (
    connector === undefined ||
    connector.kind !== "git-cli" ||
    !connector.provides.includes(capability.id) ||
    !connector.requiredEnv.includes("GIT_PUSH_ACCOUNT_ID")
  ) {
    throw new SaberError("git.push connector capability mapping is invalid", 2);
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

function writeReconciliationError(capabilityId: string): SaberError {
  return capabilityId === "gitlab.mr.create"
    ? new SaberError(
        "GitLab MR write may have succeeded; do not repeat the create action; recover with gitlab.mr.read using project, sourceBranch, and targetBranch",
        3,
      )
    : new SaberError(
        "Jira update may have succeeded; do not repeat the update action; recover with jira.read and compare the intended fields",
        3,
      );
}

function reconciliationRequest(
  capability: Capability,
  request: PreparedHttpRequest,
  writeData: JsonValue | null,
): PreparedHttpRequest | undefined {
  if (capability.id === "jira.update" && request.target.type === "jira-issue") {
    return {
      connector: "jira",
      method: "GET",
      path: request.path,
      target: request.target,
    };
  }
  if (capability.id !== "gitlab.mr.create" || request.target.type !== "gitlab-project") {
    return undefined;
  }
  if (isRecord(writeData) && Number.isSafeInteger(writeData.iid) && (writeData.iid as number) > 0) {
    const iid = writeData.iid as number;
    return {
      connector: "gitlab",
      method: "GET",
      path: `/api/v4/projects/${encodeURIComponent(request.target.project)}/merge_requests/${iid}`,
      target: { type: "gitlab-merge-request", project: request.target.project, iid },
    };
  }
  const body = request.body === undefined ? undefined : (JSON.parse(request.body) as unknown);
  if (
    !isRecord(body) ||
    typeof body.source_branch !== "string" ||
    typeof body.target_branch !== "string"
  ) {
    throw writeReconciliationError(capability.id);
  }
  const query = new URLSearchParams({
    state: "opened",
    source_branch: body.source_branch,
    target_branch: body.target_branch,
  });
  return {
    connector: "gitlab",
    method: "GET",
    path: `/api/v4/projects/${encodeURIComponent(request.target.project)}/merge_requests?${query.toString()}`,
    target: {
      type: "gitlab-merge-request-list",
      project: request.target.project,
      sourceBranch: body.source_branch,
      targetBranch: body.target_branch,
    },
  };
}

function canonicalJsonEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalizeJsonPayload(left) === canonicalizeJsonPayload(right);
}

function reconciledHttpData(
  capability: Capability,
  request: PreparedHttpRequest,
  writeData: JsonValue | null,
  data: JsonValue | null,
): JsonValue {
  const intended = request.body === undefined ? undefined : parseHttpResponseBody(request.body);
  if (capability.id === "jira.update") {
    if (!isRecord(intended) || !isRecord(intended.fields) || !isRecord(data) || !isRecord(data.fields)) {
      throw writeReconciliationError(capability.id);
    }
    for (const [field, expected] of Object.entries(intended.fields)) {
      const actual = data.fields[field];
      if (actual === undefined || !canonicalJsonEqual(expected, actual as JsonValue)) {
        throw writeReconciliationError(capability.id);
      }
    }
    return data as JsonValue;
  }
  if (capability.id !== "gitlab.mr.create" || !isRecord(intended)) {
    throw writeReconciliationError(capability.id);
  }
  const candidates = Array.isArray(data) ? data : [data];
  const expectedIid = isRecord(writeData) && Number.isSafeInteger(writeData.iid)
    ? writeData.iid
    : undefined;
  const match = candidates.find(
    (candidate) =>
      isRecord(candidate) &&
      (expectedIid === undefined || candidate.iid === expectedIid) &&
      candidate.title === intended.title &&
      candidate.source_branch === intended.source_branch &&
      candidate.target_branch === intended.target_branch &&
      candidate.state === "opened",
  );
  if (match === undefined) {
    throw writeReconciliationError(capability.id);
  }
  return match as JsonValue;
}

async function reconcileHttpWrite(
  capability: Capability,
  request: PreparedHttpRequest,
  writeData: JsonValue | null,
  environment: Readonly<Record<string, string | undefined>>,
  token: string,
  fetchImplementation: HttpFetch,
): Promise<JsonValue> {
  try {
    const reconcile = reconciliationRequest(capability, request, writeData);
    if (reconcile === undefined) {
      throw writeReconciliationError(capability.id);
    }
    const target = resolveHttpTarget(reconcile, environment);
    const response = await fetchImplementation(target.url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
    });
    if (!response.ok) {
      throw writeReconciliationError(capability.id);
    }
    return reconciledHttpData(
      capability,
      request,
      writeData,
      parseHttpResponseBody(await response.text()),
    );
  } catch {
    throw writeReconciliationError(capability.id);
  }
}

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
  const isWrite = capability.id === "jira.update" || capability.id === "gitlab.mr.create";
  let response: HttpResponse;
  try {
    response = await fetchImplementation(targetUrl, init);
  } catch {
    if (isWrite) {
      const data = await reconcileHttpWrite(
        capability,
        request,
        null,
        environment,
        token,
        fetchImplementation,
      );
      return {
        connector: request.connector,
        method: request.method,
        path: request.path,
        status: 0,
        data,
      };
    }
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
    if (
      isWrite && response.status >= 500
    ) {
      const data = await reconcileHttpWrite(
        capability,
        request,
        null,
        environment,
        token,
        fetchImplementation,
      );
      return {
        connector: request.connector,
        method: request.method,
        path: request.path,
        status: response.status,
        data,
      };
    }
    throw new SaberError(
      `${request.connector === "jira" ? "Jira" : "GitLab"} request failed with HTTP ${response.status}`,
    );
  }
  let data: JsonValue | null;
  try {
    data = parseHttpResponseBody(await response.text());
  } catch (error: unknown) {
    if (!isWrite) {
      throw error;
    }
    data = null;
  }
  if (isWrite) {
    data = await reconcileHttpWrite(
      capability,
      request,
      data,
      environment,
      token,
      fetchImplementation,
    );
  }
  return {
    connector: request.connector,
    method: request.method,
    path: request.path,
    status: response.status,
    data,
  };
}

async function executePreparedGitPush(
  gitPush: PreparedGitPush,
  runner: SafeProcessRunner,
): Promise<Omit<ActionExecution, "state" | "capabilityId" | "risk">> {
  const ref = `refs/heads/${gitPush.branch}`;
  const push = await runner({
    program: "git",
    args: [
      "-c",
      `core.hooksPath=${devNull}`,
      "push",
      "--porcelain",
      "--no-verify",
      "--no-follow-tags",
      gitPush.remoteSource,
      `${gitPush.commit}:${ref}`,
    ],
    cwd: gitPush.projectPath,
  });
  const remoteRef = await runner({
    program: "git",
    args: ["ls-remote", "--exit-code", gitPush.remoteSource, ref],
    cwd: gitPush.projectPath,
    captureStdout: true,
  });
  const remoteCommit = remoteRef.stdout?.trim().split(/\s+/u, 1)[0]?.toLowerCase();
  if (remoteRef.exitCode !== 0 || remoteCommit !== gitPush.commit) {
    throw new SaberError(
      push.exitCode === 0
        ? "git.push completed but remote reconciliation did not confirm the previewed commit; inspect the remote before retrying"
        : "git.push may have succeeded but remote reconciliation did not confirm the previewed commit; do not blindly retry; inspect the remote and create a new preview only after recovery",
      3,
    );
  }
  return {
    connector: "git",
    method: "PUSH",
    path: gitPush.project,
    status: 0,
    data: {
      project: gitPush.project,
      remote: gitPush.remote,
      branch: gitPush.branch,
      commit: gitPush.commit,
      reconciled: true,
    },
  };
}

function safeMcpResult(
  value: unknown,
  secrets: ReadonlySet<string>,
): { valid: true; data: JsonValue } | { valid: false; data: null } {
  try {
    const normalized = JSON.parse(canonicalizeJsonPayload(value)) as JsonValue;
    return { valid: true, data: redactMcpValue(normalized, secrets) };
  } catch {
    return { valid: false, data: null };
  }
}

async function executePreparedMcp(
  repositoryRoot: string,
  prepared: PreparedMcp,
  payload: unknown,
  dependencies: ActionExecutionDependencies,
): Promise<Omit<ActionExecution, "capabilityId" | "risk">> {
  const normalized = normalizedMcpArguments(payload);
  const args = normalized as Record<string, JsonValue>;
  const sensitiveValues = collectSensitiveMcpStrings(normalized);
  let client: McpClientLike | undefined;
  try {
    try {
      client = await (dependencies.connectMcp ?? connectMcpServer)(
        repositoryRoot,
        prepared.descriptor,
        dependencies.env ?? process.env,
      );
      for (const secret of client.secrets ?? []) {
        if (secret.length > 0) sensitiveValues.add(secret);
      }
    } catch {
      throw new SaberError("could not connect to the configured MCP action server", 3);
    }
    let listed: Awaited<ReturnType<McpClientLike["listTools"]>>;
    try {
      listed = await client.listTools();
    } catch {
      throw new SaberError("could not inspect upstream MCP tools", 2);
    }
    const upstreamTools = new Set(listed.tools.map((tool) => tool.name));
    if (!upstreamTools.has(prepared.toolName)) {
      throw new SaberError("configured upstream MCP tool was not found", 2);
    }
    const readAvailable =
      prepared.readToolName !== undefined && upstreamTools.has(prepared.readToolName);
    let writeData: JsonValue | null = null;
    try {
      const rawWriteData = await client.callTool({ name: prepared.toolName, arguments: args });
      const normalizedWrite = safeMcpResult(rawWriteData, sensitiveValues);
      writeData = normalizedWrite.data;
    } catch {
      writeData = null;
    }

    if (!readAvailable) {
      return {
        state: "uncertain",
        connector: "mcp",
        method: "CALL",
        path: `${prepared.serverId}/${prepared.toolName}`,
        status: 0,
        data: writeData,
        reconciliation: { state: "unavailable" },
      };
    }

    let reconciliationData: JsonValue | null = null;
    try {
      const normalizedRead = safeMcpResult(
        await client.callTool({ name: prepared.readToolName!, arguments: args }),
        sensitiveValues,
      );
      if (!normalizedRead.valid) {
        throw new Error("invalid MCP reconciliation result");
      }
      reconciliationData = normalizedRead.data;
    } catch {
      return {
        state: "uncertain",
        connector: "mcp",
        method: "CALL",
        path: `${prepared.serverId}/${prepared.toolName}`,
        status: 0,
        data: writeData,
        reconciliation: { state: "unavailable", capabilityId: prepared.readCapabilityId },
      };
    }
    return {
      state: "uncertain",
      connector: "mcp",
      method: "CALL",
      path: `${prepared.serverId}/${prepared.toolName}`,
      status: 0,
      data: writeData,
      reconciliation: {
        state: "observed",
        capabilityId: prepared.readCapabilityId,
        tool: prepared.readToolName,
        data: reconciliationData,
      },
    };
  } finally {
    try {
      await client?.close?.();
    } catch {
      // A close failure cannot justify a second external call.
    }
  }
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
  const context = await prepareActionContext(
    repositoryRoot,
    dependencies.config,
    capability,
    payload,
    dependencies.env ?? process.env,
    dependencies.runner ?? runSafeProcess,
  );
  const nonce = randomBytes(32).toString("hex");
  const record: PreviewRecord = {
    schemaVersion: 2,
    token: calculatePreviewToken(capability.id, canonicalPayload, nonce, context.targetDigest),
    nonce,
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
  const context = await prepareActionContext(
    repositoryRoot,
    config,
    capability,
    payload,
    environment,
    dependencies.runner ?? runSafeProcess,
  );
  const expectedRecord = {
    capabilityId: capability.id,
    payloadDigest: digest(canonicalPayload),
    targetDigest: context.targetDigest,
  };
  if (
    capability.risk === "L2" &&
    (dependencies.confirmation === undefined ||
      !(await consumeExactPreviewRecord(repositoryRoot, dependencies.confirmation, expectedRecord)))
  ) {
    throw confirmationRecoveryError();
  }
  if (context.mcp !== undefined) {
    const execution = await executePreparedMcp(
      repositoryRoot,
      context.mcp,
      payload,
      dependencies,
    );
    return {
      capabilityId: capability.id,
      risk: capability.risk,
      ...execution,
    };
  }
  if (context.gitPush !== undefined) {
    const execution = await executePreparedGitPush(
      context.gitPush,
      dependencies.runner ?? runSafeProcess,
    );
    return {
      state: "executed",
      capabilityId: capability.id,
      risk: capability.risk,
      ...execution,
    };
  }
  if (context.request === undefined || context.targetUrl === undefined) {
    throw new SaberError(
      "this capability has no safe HTTP executor; use its native MCP tool or add an approved connector adapter",
      3,
    );
  }
  // Re-resolve immediately before transport so an environment change cannot redirect an approved batch.
  const currentTarget = resolveHttpTarget(
    context.request,
    environment,
    capability.risk === "L2",
  );
  if (currentTarget.destinationDigest !== expectedRecord.targetDigest) {
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
