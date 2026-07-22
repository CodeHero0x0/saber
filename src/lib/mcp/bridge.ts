import { lstat, readFile, realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { SaberError } from "../errors.js";
import {
  connectMcpServer,
  type McpClientLike,
  type McpToolDescription,
} from "./client.js";
import {
  assertMcpRuntimeDescriptorActive,
  fingerprintMcpRuntimeDescriptor,
  type McpRuntimeDescriptor,
  type McpRuntimeTool,
} from "./runtime.js";

const maxDescriptorBytes = 1_000_000;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const httpHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

type BridgeCall = { name: string; arguments?: Record<string, unknown> };

export type McpBridgeHandlers = {
  listTools(): Promise<{ tools: McpToolDescription[] }>;
  callTool(request: BridgeCall): Promise<unknown>;
};

export type RunMcpBridgeOptions = {
  descriptorPath: string;
  repositoryRoot?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  environment?: Readonly<Record<string, string | undefined>>;
  connect?: typeof connectMcpServer;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStringRecord(
  value: unknown,
  keyPattern?: RegExp,
  valuePattern?: RegExp,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, item]) =>
        (keyPattern === undefined || keyPattern.test(key)) &&
        typeof item === "string" &&
        item.length > 0 &&
        (valuePattern === undefined || valuePattern.test(item)),
    )
  );
}

function isRuntimeTool(value: unknown): value is McpRuntimeTool {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["name", "capability", "risk"]) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.capability === "string" &&
    value.capability.length > 0 &&
    (value.risk === "L0" || value.risk === "L1" || value.risk === "L2" || value.risk === "L3")
  );
}

function isRuntimeServer(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || !safeSegment.test(value.id)) {
    return false;
  }
  if (value.transport === "stdio") {
    const keys = value.cwd === undefined
      ? ["id", "transport", "command", "args", "env"]
      : ["id", "transport", "command", "args", "cwd", "env"];
    return (
      hasExactKeys(value, keys) &&
      typeof value.command === "string" &&
      value.command.length > 0 &&
      Array.isArray(value.args) &&
      value.args.every((argument) => typeof argument === "string") &&
      (value.cwd === undefined || (typeof value.cwd === "string" && value.cwd.length > 0)) &&
      isStringRecord(value.env, environmentName, environmentName)
    );
  }
  if (value.transport === "http") {
    if (
      !hasExactKeys(value, ["id", "transport", "url", "headers"]) ||
      typeof value.url !== "string" ||
      !isStringRecord(value.headers, httpHeaderName, environmentName)
    ) {
      return false;
    }
    try {
      const url = new URL(value.url);
      return url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

function parseDescriptor(text: string): McpRuntimeDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SaberError("could not parse MCP runtime descriptor", 2);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "managedBy",
      "tool",
      "target",
      "server",
      "tools",
      "sourceFingerprint",
      "descriptorFingerprint",
    ]) ||
    value.schemaVersion !== 1 ||
    value.managedBy !== "saber" ||
    (value.tool !== "codex" && value.tool !== "claude" && value.tool !== "opencode") ||
    typeof value.target !== "string" ||
    !safeSegment.test(value.target) ||
    !isRuntimeServer(value.server) ||
    !Array.isArray(value.tools) ||
    !value.tools.every(isRuntimeTool) ||
    typeof value.sourceFingerprint !== "string" ||
    !fingerprintPattern.test(value.sourceFingerprint) ||
    typeof value.descriptorFingerprint !== "string" ||
    !fingerprintPattern.test(value.descriptorFingerprint)
  ) {
    throw new SaberError("invalid MCP runtime descriptor", 2);
  }

  const descriptor = value as McpRuntimeDescriptor;
  const names = new Set<string>();
  for (const tool of descriptor.tools) {
    if (names.has(tool.name)) {
      throw new SaberError("invalid MCP runtime descriptor", 2);
    }
    names.add(tool.name);
  }
  if (fingerprintMcpRuntimeDescriptor(descriptor) !== descriptor.descriptorFingerprint) {
    throw new SaberError("MCP runtime descriptor fingerprint mismatch", 2);
  }
  return descriptor;
}

function outside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** Load a strict descriptor only from `.saber/runtime/mcp/<tool>/<target>/<server>.json`. */
export async function loadMcpRuntimeDescriptor(
  repositoryRoot: string,
  descriptorPath: string,
  { requireActive = true }: { requireActive?: boolean } = {},
): Promise<McpRuntimeDescriptor> {
  const lexicalRoot = resolve(repositoryRoot);
  const managedRoot = resolve(lexicalRoot, ".saber", "runtime", "mcp");
  const absoluteDescriptorPath = isAbsolute(descriptorPath);
  const requested = absoluteDescriptorPath
    ? resolve(descriptorPath)
    : resolve(lexicalRoot, descriptorPath);
  if (!absoluteDescriptorPath && outside(managedRoot, requested)) {
    throw new SaberError("descriptor path is outside the managed MCP runtime", 2);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requested);
  } catch {
    throw new SaberError("MCP runtime descriptor is missing", 2);
  }
  const canonicalManagedRoot = await realpath(managedRoot);
  if (outside(canonicalManagedRoot, canonicalPath)) {
    throw new SaberError("descriptor path is outside the managed MCP runtime", 2);
  }
  const stat = await lstat(canonicalPath);
  if (!stat.isFile() || stat.size > maxDescriptorBytes) {
    throw new SaberError("invalid MCP runtime descriptor", 2);
  }
  const descriptor = parseDescriptor(await readFile(canonicalPath, "utf8"));
  const relativePath = relative(canonicalManagedRoot, canonicalPath).split(sep);
  if (
    relativePath.length !== 3 ||
    relativePath[0] !== descriptor.tool ||
    relativePath[1] !== descriptor.target ||
    basename(relativePath[2] as string, ".json") !== descriptor.server.id ||
    !(relativePath[2] as string).endsWith(".json")
  ) {
    throw new SaberError("MCP runtime descriptor path does not match its content", 2);
  }
  if (requireActive) {
    await assertMcpRuntimeDescriptorActive(repositoryRoot, canonicalPath, descriptor);
  }
  return descriptor;
}

function allowedMappings(descriptor: McpRuntimeDescriptor): Map<string, McpRuntimeTool> {
  return new Map(
    descriptor.tools
      .filter((tool) => tool.risk === "L0" || tool.risk === "L1")
      .map((tool) => [tool.name, tool]),
  );
}

/** Create the filtered proxy surface independently of the stdio transport for focused testing. */
export function createMcpBridgeHandlers(
  descriptor: McpRuntimeDescriptor,
  upstream: McpClientLike,
  assertCurrent: () => Promise<void> = async () => undefined,
): McpBridgeHandlers {
  const allowed = allowedMappings(descriptor);

  async function currentlyAvailable(): Promise<Map<string, McpToolDescription>> {
    await assertCurrent();
    let listed: { tools: McpToolDescription[] };
    try {
      listed = await upstream.listTools();
    } catch {
      throw new SaberError("upstream MCP tools/list failed", 1);
    }
    return new Map(
      listed.tools
        .filter((tool) => allowed.has(tool.name))
        .map((tool) => [tool.name, tool]),
    );
  }

  return {
    async listTools() {
      return { tools: [...(await currentlyAvailable()).values()] };
    },
    async callTool(request) {
      if (!allowed.has(request.name) || !(await currentlyAvailable()).has(request.name)) {
        throw new SaberError("MCP tool is not available through this bridge", 3);
      }
      try {
        return await upstream.callTool(request);
      } catch {
        throw new SaberError("upstream MCP tool call failed", 1);
      }
    },
  };
}

function safeBridgeError(error: unknown): string {
  return error instanceof SaberError ? error.message : "MCP bridge failed";
}

/** Run one filtered bridge as an SDK-backed stdio MCP server. */
export async function runMcpBridge(options: RunMcpBridgeOptions): Promise<void> {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const stderr = options.stderr ?? process.stderr;
  let upstream: McpClientLike | undefined;
  try {
    const descriptor = await loadMcpRuntimeDescriptor(repositoryRoot, options.descriptorPath);
    upstream = await (options.connect ?? connectMcpServer)(
      repositoryRoot,
      descriptor,
      options.environment,
    );
    const assertCurrent = async (): Promise<void> => {
      const current = await loadMcpRuntimeDescriptor(repositoryRoot, options.descriptorPath);
      if (current.descriptorFingerprint !== descriptor.descriptorFingerprint) {
        throw new SaberError("MCP runtime descriptor changed; restart the bridge", 2);
      }
    };
    const handlers = createMcpBridgeHandlers(descriptor, upstream, assertCurrent);
    const server = new Server(
      { name: `saber--${descriptor.server.id}`, version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => handlers.listTools());
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await handlers.callTool(request.params) as never;
      } catch (error: unknown) {
        throw new McpError(ErrorCode.InvalidParams, safeBridgeError(error));
      }
    });
    server.onclose = () => {
      void upstream?.close?.();
    };
    await server.connect(new StdioServerTransport(options.stdin, options.stdout));
  } catch (error: unknown) {
    await upstream?.close?.().catch(() => undefined);
    stderr.write(`${safeBridgeError(error)}\n`);
    throw error;
  }
}
