import { lstat } from "node:fs/promises";

import { SaberError } from "../errors.js";
import { readTextWithinRoot, resolveExistingPathWithinRoot } from "../files.js";
import type { McpRuntimeDescriptor } from "./runtime.js";

export type McpToolDescription = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
};

export type McpClientLike = {
  readonly secrets?: readonly string[];
  listTools(): Promise<{ tools: McpToolDescription[] }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close?(): Promise<void>;
};

export const MCP_REQUEST_TIMEOUT_MS = 10_000;
const MCP_CONNECT_TIMEOUT_FLOOR_MS = 1_000;

export type LoadedMcpEnvironment = {
  /** Downstream stdio environment or HTTP headers, keyed by configured destination names. */
  values: Record<string, string>;
  /** Values retained only in memory so diagnostics can redact them. */
  secrets: string[];
};

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readWorkspaceEnvironment(repositoryRoot: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readTextWithinRoot(repositoryRoot, ".env");
  } catch (error: unknown) {
    if (isMissingFile(error)) return {};
    throw new SaberError("could not read workspace .env", 2);
  }
  try {
    const { parse } = await import("dotenv");
    return parse(text);
  } catch (error: unknown) {
    if (error instanceof SaberError) throw error;
    throw new SaberError("could not parse workspace .env", 2);
  }
}

function environmentReferences(descriptor: McpRuntimeDescriptor): Record<string, string> {
  return descriptor.server.transport === "stdio"
    ? descriptor.server.env
    : descriptor.server.headers;
}

/** Resolve only named references; unrelated process and `.env` values never cross the bridge. */
export async function loadMcpEnvironment(
  repositoryRoot: string,
  descriptor: McpRuntimeDescriptor,
  processEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LoadedMcpEnvironment> {
  const workspaceEnvironment = await readWorkspaceEnvironment(repositoryRoot);
  const values: Record<string, string> = {};
  const secrets: string[] = [];

  for (const [destination, source] of Object.entries(environmentReferences(descriptor))) {
    const value = processEnvironment[source] ?? workspaceEnvironment[source];
    if (value === undefined || value.length === 0) {
      throw new SaberError(`MCP environment variable ${source} is not configured`, 3);
    }
    values[destination] = value;
    if (!secrets.includes(value)) secrets.push(value);
  }
  return { values, secrets };
}

async function resolveStdioCwd(
  repositoryRoot: string,
  configuredCwd: string | undefined,
): Promise<string> {
  try {
    const cwd = await resolveExistingPathWithinRoot(repositoryRoot, configuredCwd ?? ".");
    if (!(await lstat(cwd)).isDirectory()) {
      throw new Error("not a directory");
    }
    return cwd;
  } catch {
    throw new SaberError("MCP stdio cwd is missing or escapes repository root", 2);
  }
}

/** Connect to a configured upstream using the official MCP SDK transports. */
export async function connectMcpServer(
  repositoryRoot: string,
  descriptor: McpRuntimeDescriptor,
  processEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  requestTimeoutMilliseconds = MCP_REQUEST_TIMEOUT_MS,
): Promise<McpClientLike> {
  const loaded = await loadMcpEnvironment(repositoryRoot, descriptor, processEnvironment);
  const [{ Client }, transportModule] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    descriptor.server.transport === "stdio"
      ? import("@modelcontextprotocol/sdk/client/stdio.js")
      : import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "saber-mcp-bridge", version: "0.1.0" });
  const requestOptions = { timeout: requestTimeoutMilliseconds };
  const connectOptions = {
    timeout: Math.max(requestTimeoutMilliseconds, MCP_CONNECT_TIMEOUT_FLOOR_MS),
  };

  if (descriptor.server.transport === "stdio") {
    const { StdioClientTransport, getDefaultEnvironment } =
      transportModule as typeof import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: descriptor.server.command,
      args: descriptor.server.args,
      cwd: await resolveStdioCwd(repositoryRoot, descriptor.server.cwd),
      env: { ...getDefaultEnvironment(), ...loaded.values },
      stderr: "ignore",
    });
    await client.connect(transport, connectOptions);
  } else {
    const { StreamableHTTPClientTransport } =
      transportModule as typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const transport = new StreamableHTTPClientTransport(new URL(descriptor.server.url), {
      requestInit: { headers: loaded.values },
    });
    await client.connect(transport, connectOptions);
  }

  const wrapped: McpClientLike = {
    async listTools() {
      try {
        return await client.listTools(undefined, requestOptions);
      } catch {
        throw new SaberError("upstream MCP tools/list failed", 1);
      }
    },
    async callTool(request) {
      try {
        return await client.callTool(request, undefined, requestOptions);
      } catch {
        throw new SaberError("upstream MCP tool call failed", 1);
      }
    },
    async close() {
      await client.close();
    },
  };
  Object.defineProperty(wrapped, "secrets", {
    value: Object.freeze([...loaded.secrets]),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return wrapped;
}
