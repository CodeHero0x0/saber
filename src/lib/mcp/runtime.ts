import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { SaberError } from "../errors.js";
import type { RiskLevel, ToolName } from "../models.js";

export type RuntimeMcpToolConfig = {
  name: string;
  capability: string;
};

export type RuntimeStdioMcpServerConfig = {
  id: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  tools: RuntimeMcpToolConfig[];
};

export type RuntimeHttpMcpServerConfig = {
  id: string;
  transport: "http";
  url: string;
  headers: Record<string, string>;
  tools: RuntimeMcpToolConfig[];
};

export type RuntimeMcpServerConfig =
  | RuntimeStdioMcpServerConfig
  | RuntimeHttpMcpServerConfig;

export type McpRuntimeTool = RuntimeMcpToolConfig & {
  risk: RiskLevel;
};

export type McpRuntimeServer =
  | Omit<RuntimeStdioMcpServerConfig, "tools">
  | Omit<RuntimeHttpMcpServerConfig, "tools">;

export type McpRuntimeDescriptor = {
  schemaVersion: 1;
  managedBy: "saber";
  tool: ToolName;
  target: string;
  server: McpRuntimeServer;
  tools: McpRuntimeTool[];
  sourceFingerprint: string;
  descriptorFingerprint: string;
};

export type McpRuntimeResolution = {
  tool: ToolName;
  target: string;
  descriptors: McpRuntimeDescriptor[];
};

export type McpRuntimeActiveDescriptor = {
  file: string;
  descriptorFingerprint: string;
  sourceFingerprint: string;
};

export type McpRuntimeActiveIndex = {
  schemaVersion: 1;
  managedBy: "saber";
  tool: ToolName;
  target: string;
  descriptors: McpRuntimeActiveDescriptor[];
  activeFingerprint: string;
};

type McpRuntimeConfiguration = {
  capabilities: readonly { id: string; risk: RiskLevel }[];
  mcp: { servers: readonly RuntimeMcpServerConfig[] };
  local?: {
    mcp?: { servers: readonly RuntimeMcpServerConfig[] };
    extensions?: { mcpServers?: readonly string[] };
  };
};

export type ResolveMcpRuntimeOptions = {
  tool: ToolName;
  target?: string;
  role?: string;
  project?: string;
  capabilities: readonly string[];
  explicitServerIds?: readonly string[];
};

const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function fingerprintMcpValue(value: unknown): string {
  const canonical = JSON.stringify(stableValue(value));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function descriptorWithoutFingerprint(
  descriptor: Omit<McpRuntimeDescriptor, "descriptorFingerprint"> | McpRuntimeDescriptor,
): Omit<McpRuntimeDescriptor, "descriptorFingerprint"> {
  const { descriptorFingerprint: _ignored, ...content } = descriptor as McpRuntimeDescriptor;
  return content;
}

export function fingerprintMcpRuntimeDescriptor(
  descriptor: Omit<McpRuntimeDescriptor, "descriptorFingerprint"> | McpRuntimeDescriptor,
): string {
  return fingerprintMcpValue(descriptorWithoutFingerprint(descriptor));
}

function activeIndexWithoutFingerprint(
  index: Omit<McpRuntimeActiveIndex, "activeFingerprint"> | McpRuntimeActiveIndex,
): Omit<McpRuntimeActiveIndex, "activeFingerprint"> {
  const { activeFingerprint: _ignored, ...content } = index as McpRuntimeActiveIndex;
  return content;
}

export function fingerprintMcpRuntimeActiveIndex(
  index: Omit<McpRuntimeActiveIndex, "activeFingerprint"> | McpRuntimeActiveIndex,
): string {
  return fingerprintMcpValue(activeIndexWithoutFingerprint(index));
}

function requireSafeSegment(value: string, label: string): void {
  if (!safeSegment.test(value)) {
    throw new SaberError(`invalid MCP ${label}`, 2);
  }
}

function normalizedTarget(options: ResolveMcpRuntimeOptions): string {
  const target = options.target ?? (options.project === undefined ? "workspace" : `project--${options.project}`);
  requireSafeSegment(target, "target");
  return target;
}

function serverWithoutTools(server: RuntimeMcpServerConfig): McpRuntimeServer {
  if (server.transport === "stdio") {
    return {
      id: server.id,
      transport: server.transport,
      command: server.command,
      args: [...server.args],
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      env: { ...server.env },
    };
  }
  return {
    id: server.id,
    transport: server.transport,
    url: server.url,
    headers: { ...server.headers },
  };
}

/** Select servers first, then independently constrain each selected server's tools. */
export function resolveMcpRuntime(
  _repositoryRoot: string,
  config: McpRuntimeConfiguration,
  options: ResolveMcpRuntimeOptions,
): McpRuntimeResolution {
  const target = normalizedTarget(options);
  const effectiveCapabilities = new Set(options.capabilities);
  const explicitServerIds = new Set([
    ...(config.local?.extensions?.mcpServers ?? []),
    ...(options.explicitServerIds ?? []),
  ]);
  const risks = new Map(config.capabilities.map((capability) => [capability.id, capability.risk]));
  const configuredServers = [
    ...config.mcp.servers,
    ...(config.local?.mcp?.servers ?? []),
  ];
  const descriptors: McpRuntimeDescriptor[] = [];

  for (const server of configuredServers) {
    requireSafeSegment(server.id, "server id");
    const selected =
      explicitServerIds.has(server.id) ||
      server.tools.some((tool) => effectiveCapabilities.has(tool.capability));
    if (!selected) continue;

    const tools = server.tools.flatMap((tool): McpRuntimeTool[] => {
      if (!effectiveCapabilities.has(tool.capability)) return [];
      const risk = risks.get(tool.capability);
      if (risk === undefined) {
        throw new SaberError(`MCP tool ${tool.name} references an unknown capability`, 2);
      }
      return [{ name: tool.name, capability: tool.capability, risk }];
    });

    const sourceFingerprint = fingerprintMcpValue({
      server,
      tools,
      effectiveCapabilities: [...effectiveCapabilities].sort(),
    });
    const content: Omit<McpRuntimeDescriptor, "descriptorFingerprint"> = {
      schemaVersion: 1,
      managedBy: "saber",
      tool: options.tool,
      target,
      server: serverWithoutTools(server),
      tools,
      sourceFingerprint,
    };
    descriptors.push({
      ...content,
      descriptorFingerprint: fingerprintMcpRuntimeDescriptor(content),
    });
  }

  return { tool: options.tool, target, descriptors };
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function resolveMcpTargetDirectory(
  repositoryRoot: string,
  tool: ToolName,
  target: string,
  create: boolean,
): Promise<string> {
  requireSafeSegment(tool, "tool");
  requireSafeSegment(target, "target");
  const canonicalRoot = await realpath(repositoryRoot);
  const components = [".saber", "runtime", "mcp", tool, target];
  let current = canonicalRoot;

  for (const component of components) {
    current = join(current, component);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error: unknown) {
      if (!isMissingPath(error) || !create) {
        throw new SaberError("managed MCP runtime directory is missing", 2);
      }
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SaberError("managed MCP runtime namespace contains a symbolic link or non-directory", 2);
    }
  }

  const canonicalManagedRoot = await realpath(join(canonicalRoot, ".saber", "runtime", "mcp"));
  const canonicalTarget = await realpath(current);
  if (
    relative(canonicalRoot, canonicalManagedRoot) !== join(".saber", "runtime", "mcp") ||
    relative(canonicalManagedRoot, canonicalTarget) !== join(tool, target)
  ) {
    throw new SaberError("managed MCP runtime target is outside its namespace", 2);
  }
  return canonicalTarget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseActiveIndex(text: string): McpRuntimeActiveIndex {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SaberError("invalid MCP active index", 2);
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "managedBy", "tool", "target", "descriptors", "activeFingerprint"]) ||
    value.schemaVersion !== 1 ||
    value.managedBy !== "saber" ||
    (value.tool !== "codex" && value.tool !== "claude" && value.tool !== "opencode") ||
    typeof value.target !== "string" ||
    !safeSegment.test(value.target) ||
    !Array.isArray(value.descriptors) ||
    !value.descriptors.every((entry) => {
      if (!isRecord(entry) || !exactKeys(entry, ["file", "descriptorFingerprint", "sourceFingerprint"])) return false;
      return (
        typeof entry.file === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(entry.file) &&
        fingerprintPattern.test(String(entry.descriptorFingerprint)) &&
        fingerprintPattern.test(String(entry.sourceFingerprint))
      );
    }) ||
    typeof value.activeFingerprint !== "string" ||
    !fingerprintPattern.test(value.activeFingerprint)
  ) {
    throw new SaberError("invalid MCP active index", 2);
  }
  const index = value as McpRuntimeActiveIndex;
  const files = new Set<string>();
  for (const entry of index.descriptors) {
    if (files.has(entry.file)) throw new SaberError("invalid MCP active index", 2);
    files.add(entry.file);
  }
  if (fingerprintMcpRuntimeActiveIndex(index) !== index.activeFingerprint) {
    throw new SaberError("MCP active index fingerprint mismatch", 2);
  }
  return index;
}

async function validateIndexedDescriptor(
  directory: string,
  entry: McpRuntimeActiveDescriptor,
): Promise<void> {
  const path = join(directory, entry.file);
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    throw new SaberError("MCP active index references an invalid descriptor", 2);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new SaberError("MCP active index references an invalid descriptor", 2);
  }
  if (!isRecord(value) || typeof value.descriptorFingerprint !== "string" || typeof value.sourceFingerprint !== "string") {
    throw new SaberError("MCP active index references an invalid descriptor", 2);
  }
  if (
    value.descriptorFingerprint !== entry.descriptorFingerprint ||
    value.sourceFingerprint !== entry.sourceFingerprint ||
    fingerprintMcpRuntimeDescriptor(value as McpRuntimeDescriptor) !== entry.descriptorFingerprint
  ) {
    throw new SaberError("MCP active index descriptor fingerprint mismatch", 2);
  }
}

/** Read and validate the directory-level Saber ownership record and every referenced descriptor. */
export async function loadMcpActiveIndex(
  repositoryRoot: string,
  tool: ToolName,
  target: string,
): Promise<McpRuntimeActiveIndex> {
  requireSafeSegment(target, "target");
  const directory = await resolveMcpTargetDirectory(repositoryRoot, tool, target, false);
  const indexPath = join(directory, "_active.json");
  const indexStat = await lstat(join(directory, "_active.json")).catch(() => undefined);
  if (indexStat === undefined || !indexStat.isFile() || indexStat.isSymbolicLink()) {
    throw new SaberError("MCP active index is missing", 2);
  }
  let index: McpRuntimeActiveIndex;
  try {
    index = parseActiveIndex(await readFile(indexPath, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SaberError) throw error;
    throw new SaberError("MCP active index is missing", 2);
  }
  if (index.tool !== tool || index.target !== target) throw new SaberError("MCP active index target mismatch", 2);
  const entries = await readdir(directory);
  const expected = new Set(["_active.json", ...index.descriptors.map((entry) => entry.file)]);
  if (entries.some((entry) => !expected.has(entry))) {
    throw new SaberError("MCP runtime directory contains unmanaged content", 2);
  }
  for (const entry of index.descriptors) await validateIndexedDescriptor(directory, entry);
  return index;
}

/** Ensure a descriptor remains the exact active file recorded by the current index. */
export async function assertMcpRuntimeDescriptorActive(
  repositoryRoot: string,
  descriptorPath: string,
  descriptor: McpRuntimeDescriptor,
): Promise<void> {
  const index = await loadMcpActiveIndex(repositoryRoot, descriptor.tool, descriptor.target);
  const directory = await resolveMcpTargetDirectory(
    repositoryRoot,
    descriptor.tool,
    descriptor.target,
    false,
  );
  const pathFromDirectory = relative(resolve(directory), resolve(descriptorPath));
  const file = pathFromDirectory === ".." || pathFromDirectory.startsWith("../") || isAbsolute(pathFromDirectory)
    ? ""
    : pathFromDirectory;
  const entry = index.descriptors.find((candidate) => candidate.file === file);
  if (entry === undefined || entry.descriptorFingerprint !== descriptor.descriptorFingerprint || entry.sourceFingerprint !== descriptor.sourceFingerprint) {
    throw new SaberError("MCP descriptor is not active", 3);
  }
}

/** Write secret-free bridge descriptors below the repository-owned runtime namespace. */
export async function writeMcpRuntimeDescriptors(
  repositoryRoot: string,
  resolved: McpRuntimeResolution,
): Promise<string[]> {
  requireSafeSegment(resolved.tool, "tool");
  requireSafeSegment(resolved.target, "target");
  const directory = await resolveMcpTargetDirectory(
    repositoryRoot,
    resolved.tool,
    resolved.target,
    true,
  );

  const existingEntries = await readdir(directory);
  let previous: McpRuntimeActiveIndex | undefined;
  if (existingEntries.length > 0) {
    if (!existingEntries.includes("_active.json")) {
      throw new SaberError("MCP runtime directory is not Saber-owned", 2);
    }
    previous = await loadMcpActiveIndex(repositoryRoot, resolved.tool, resolved.target);
  }

  const paths: string[] = [];
  for (const descriptor of resolved.descriptors) {
    requireSafeSegment(descriptor.server.id, "server id");
    const path = join(directory, `${descriptor.server.id}.json`);
    await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    paths.push(path);
  }
  const activeIndexContent: Omit<McpRuntimeActiveIndex, "activeFingerprint"> = {
    schemaVersion: 1,
    managedBy: "saber",
    tool: resolved.tool,
    target: resolved.target,
    descriptors: resolved.descriptors.map((descriptor) => ({
      file: `${descriptor.server.id}.json`,
      descriptorFingerprint: descriptor.descriptorFingerprint,
      sourceFingerprint: descriptor.sourceFingerprint,
    })),
  };
  const activeIndex: McpRuntimeActiveIndex = {
    ...activeIndexContent,
    activeFingerprint: fingerprintMcpRuntimeActiveIndex(activeIndexContent),
  };
  const currentFiles = new Set(activeIndex.descriptors.map((entry) => entry.file));
  if (previous !== undefined) {
    const stale = previous.descriptors.filter((entry) => !currentFiles.has(entry.file));
    for (const entry of stale) {
      const stalePath = join(directory, entry.file);
      await validateIndexedDescriptor(directory, entry);
      await unlink(stalePath);
    }
  }
  await writeFile(join(directory, "_active.json"), `${JSON.stringify(activeIndex, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return paths;
}
