import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { runMcpCommand } from "../src/commands/mcp.js";
import { SaberError } from "../src/lib/errors.js";
import { createMcpBridgeHandlers, loadMcpRuntimeDescriptor } from "../src/lib/mcp/bridge.js";
import { connectMcpServer, loadMcpEnvironment } from "../src/lib/mcp/client.js";
import {
  resolveMcpRuntime,
  fingerprintMcpRuntimeDescriptor,
  writeMcpRuntimeDescriptors,
  type McpRuntimeDescriptor,
} from "../src/lib/mcp/runtime.js";

const configuration = {
  capabilities: [
    { id: "data.read", risk: "L0", kind: "read" },
    { id: "cache.refresh", risk: "L1", kind: "action" },
    { id: "data.write", risk: "L2", kind: "action" },
    { id: "system.destroy", risk: "L3", kind: "action" },
  ],
  mcp: {
    servers: [
      {
        id: "stdio-data",
        transport: "stdio",
        command: "/usr/bin/mock-mcp",
        args: ["--stdio"],
        cwd: ".",
        env: { DATA_TOKEN: "WORKSPACE_DATA_TOKEN" },
        tools: [
          { name: "read_data", capability: "data.read" },
          { name: "refresh_cache", capability: "cache.refresh" },
          { name: "write_data", capability: "data.write" },
          { name: "destroy_system", capability: "system.destroy" },
        ],
      },
      {
        id: "http-extra",
        transport: "http",
        url: "https://mcp.example.test/service",
        headers: { Authorization: "WORKSPACE_HTTP_AUTH" },
        tools: [{ name: "read_extra", capability: "data.read" }],
      },
    ],
  },
};

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "saber-mcp-bridge-"));
  await mkdir(join(root, ".saber", "runtime", "mcp"), { recursive: true });
  return root;
}

test("resolveMcpRuntime selects servers separately from filtering their tools", () => {
  const resolved = resolveMcpRuntime("/workspace", configuration, {
    tool: "codex",
    target: "root",
    capabilities: ["data.read", "data.write"],
    explicitServerIds: ["http-extra"],
  });

  assert.deepEqual(
    resolved.descriptors.map((descriptor) => descriptor.server.id),
    ["stdio-data", "http-extra"],
  );
  assert.deepEqual(
    resolved.descriptors[0]?.tools.map((tool) => [tool.name, tool.capability, tool.risk]),
    [
      ["read_data", "data.read", "L0"],
      ["write_data", "data.write", "L2"],
    ],
  );
  assert.deepEqual(resolved.descriptors[1]?.server, {
    id: "http-extra",
    transport: "http",
    url: "https://mcp.example.test/service",
    headers: { Authorization: "WORKSPACE_HTTP_AUTH" },
  });

  const explicitOnly = resolveMcpRuntime("/workspace", configuration, {
    tool: "claude",
    target: "root",
    capabilities: [],
    explicitServerIds: ["http-extra"],
  });
  assert.equal(explicitOnly.descriptors.length, 1);
  assert.deepEqual(explicitOnly.descriptors[0]?.tools, []);
});

test("runtime descriptors contain environment names and fingerprints but no values", async () => {
  const root = await temporaryRepository();
  const secret = "do-not-persist-this-secret";
  try {
    const resolved = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    });
    const paths = await writeMcpRuntimeDescriptors(root, resolved);
    assert.equal(paths.length, 2);

    const text = await readFile(paths[0] as string, "utf8");
    assert.match(text, /WORKSPACE_DATA_TOKEN/u);
    assert.match(text, /sha256:[a-f0-9]{64}/u);
    assert.doesNotMatch(text, new RegExp(secret, "u"));
    const active = await readFile(join(root, ".saber/runtime/mcp/codex/root/_active.json"), "utf8");
    assert.match(active, /"managedBy": "saber"/u);
    assert.match(active, /"descriptorFingerprint": "sha256:/u);

    const loaded = await loadMcpRuntimeDescriptor(root, paths[0] as string);
    assert.equal(loaded.server.id, "stdio-data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor replacement requires an active index and cleans only indexed stale servers", async () => {
  const root = await temporaryRepository();
  try {
    const first = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    });
    const firstPaths = await writeMcpRuntimeDescriptors(root, first);
    const oldPath = firstPaths.find((path) => path.endsWith("stdio-data.json")) as string;
    const oldText = await readFile(oldPath, "utf8");

    const httpOnly = {
      ...configuration,
      mcp: { servers: [configuration.mcp.servers[1] as (typeof configuration.mcp.servers)[number]] },
    };
    await writeMcpRuntimeDescriptors(root, resolveMcpRuntime(root, httpOnly, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    }));
    await assert.rejects(() => readFile(oldPath, "utf8"), /ENOENT/u);

    await writeFile(oldPath, oldText, "utf8");
    await assert.rejects(() => loadMcpRuntimeDescriptor(root, oldPath), /unmanaged content|not active/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor writing refuses non-empty runtime directories without valid ownership", async () => {
  const root = await temporaryRepository();
  try {
    const directory = join(root, ".saber/runtime/mcp/codex/root");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "user-owned.json"), "{}\n", "utf8");
    const resolved = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    });
    await assert.rejects(
      () => writeMcpRuntimeDescriptors(root, resolved),
      /not Saber-owned/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor writing rejects a target symlink into another repository directory", async () => {
  const root = await temporaryRepository();
  try {
    const shadow = join(root, "runtime-shadow");
    const toolDirectory = join(root, ".saber/runtime/mcp/codex");
    await mkdir(shadow);
    await mkdir(toolDirectory);
    await symlink(shadow, join(toolDirectory, "root"), "dir");
    const resolved = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    });

    await assert.rejects(
      () => writeMcpRuntimeDescriptors(root, resolved),
      /symbolic link|managed MCP runtime namespace/u,
    );
    assert.deepEqual(await readdir(shadow), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active index tampering revokes an otherwise valid descriptor", async () => {
  const root = await temporaryRepository();
  try {
    const [descriptorPath] = await writeMcpRuntimeDescriptors(root, resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    }));
    const indexPath = join(root, ".saber/runtime/mcp/codex/root/_active.json");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, index.replace("stdio-data.json", "changed.json"), "utf8");
    await assert.rejects(
      () => loadMcpRuntimeDescriptor(root, descriptorPath as string),
      /active index fingerprint/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor validation rejects invalid environment references, header names, and extra fields", async () => {
  const root = await temporaryRepository();
  const httpRoot = await temporaryRepository();
  try {
    const resolved = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    });
    const paths = await writeMcpRuntimeDescriptors(root, resolved);
    const stdioPath = paths.find((path) => path.endsWith("stdio-data.json")) as string;
    const stdio = JSON.parse(await readFile(stdioPath, "utf8"));
    stdio.server.env.DATA_TOKEN = "not an env name";
    stdio.descriptorFingerprint = fingerprintMcpRuntimeDescriptor(stdio);
    await writeFile(stdioPath, `${JSON.stringify(stdio)}\n`, "utf8");
    await assert.rejects(() => loadMcpRuntimeDescriptor(root, stdioPath), /invalid MCP runtime descriptor/u);

    const fresh = await writeMcpRuntimeDescriptors(httpRoot, resolveMcpRuntime(httpRoot, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    }));
    const httpPath = fresh.find((path) => path.endsWith("http-extra.json")) as string;
    const http = JSON.parse(await readFile(httpPath, "utf8"));
    http.server.headers = { "Bad Header": "WORKSPACE_HTTP_AUTH" };
    http.unexpected = true;
    http.descriptorFingerprint = fingerprintMcpRuntimeDescriptor(http);
    await writeFile(httpPath, `${JSON.stringify(http)}\n`, "utf8");
    await assert.rejects(
      () => loadMcpRuntimeDescriptor(httpRoot, httpPath),
      /invalid MCP runtime descriptor/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(httpRoot, { recursive: true, force: true });
  }
});

test("loadMcpEnvironment reads .env but returns only explicitly referenced values", async () => {
  const root = await temporaryRepository();
  try {
    await writeFile(
      join(root, ".env"),
      "WORKSPACE_DATA_TOKEN=allowed-secret\nUNRELATED_SECRET=must-not-be-forwarded\n",
      "utf8",
    );
    const descriptor = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    }).descriptors[0] as McpRuntimeDescriptor;

    const loaded = await loadMcpEnvironment(root, descriptor, {});
    assert.deepEqual(loaded.values, { DATA_TOKEN: "allowed-secret" });
    assert.deepEqual(loaded.secrets, ["allowed-secret"]);
    assert.equal("UNRELATED_SECRET" in loaded.values, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge exposes and proxies only mapped, available L0/L1 tools", async () => {
  const descriptor = resolveMcpRuntime("/workspace", configuration, {
    tool: "codex",
    target: "root",
    capabilities: ["data.read", "cache.refresh", "data.write", "system.destroy"],
  }).descriptors[0] as McpRuntimeDescriptor;
  const calls: string[] = [];
  const upstream = {
    listTools: async () => ({
      tools: [
        { name: "read_data", description: "Read data", inputSchema: { type: "object" as const } },
        { name: "refresh_cache", inputSchema: { type: "object" as const } },
        { name: "write_data", inputSchema: { type: "object" as const } },
        { name: "destroy_system", inputSchema: { type: "object" as const } },
        { name: "undeclared_tool", inputSchema: { type: "object" as const } },
      ],
    }),
    callTool: async ({ name }: { name: string }) => {
      calls.push(name);
      return { content: [{ type: "text" as const, text: `${name}:ok` }] };
    },
  };
  const handlers = createMcpBridgeHandlers(descriptor, upstream);

  assert.deepEqual(
    (await handlers.listTools()).tools.map((tool) => tool.name),
    ["read_data", "refresh_cache"],
  );
  assert.deepEqual(await handlers.callTool({ name: "read_data", arguments: {} }), {
    content: [{ type: "text", text: "read_data:ok" }],
  });
  assert.deepEqual(calls, ["read_data"]);

  for (const name of ["write_data", "destroy_system", "undeclared_tool", "missing_upstream"]) {
    await assert.rejects(() => handlers.callTool({ name, arguments: {} }), /not available/u);
  }
  assert.deepEqual(calls, ["read_data"]);
});

test("bridge converts upstream list, availability, and call failures to stable safe errors", async () => {
  const descriptor = resolveMcpRuntime("/workspace", configuration, {
    tool: "codex",
    target: "root",
    capabilities: ["data.read"],
  }).descriptors[0] as McpRuntimeDescriptor;
  const secret = "upstream-secret-must-not-leak";
  const safeError = (message: string) => (error: unknown): boolean => {
    assert.ok(error instanceof SaberError);
    assert.equal(error.message, message);
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    return true;
  };

  const unavailable = createMcpBridgeHandlers(descriptor, {
    listTools: async () => { throw new Error(secret); },
    callTool: async () => { throw new Error("unexpected call"); },
  });
  await assert.rejects(
    () => unavailable.listTools(),
    safeError("upstream MCP tools/list failed"),
  );
  await assert.rejects(
    () => unavailable.callTool({ name: "read_data", arguments: {} }),
    safeError("upstream MCP tools/list failed"),
  );

  const callFailure = createMcpBridgeHandlers(descriptor, {
    listTools: async () => ({
      tools: [{ name: "read_data", inputSchema: { type: "object" as const } }],
    }),
    callTool: async () => { throw new Error(secret); },
  });
  await assert.rejects(
    () => callFailure.callTool({ name: "read_data", arguments: {} }),
    safeError("upstream MCP tool call failed"),
  );
});

test("bridge request checks revoke a descriptor removed from the active index", async () => {
  const root = await temporaryRepository();
  try {
    const resolved = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    });
    const [descriptorPath] = await writeMcpRuntimeDescriptors(root, resolved);
    const descriptor = resolved.descriptors[0] as McpRuntimeDescriptor;
    const upstream = {
      listTools: async () => ({
        tools: [{ name: "read_data", inputSchema: { type: "object" as const } }],
      }),
      callTool: async () => ({ content: [] }),
    };
    const handlers = createMcpBridgeHandlers(
      descriptor,
      upstream,
      async () => { await loadMcpRuntimeDescriptor(root, descriptorPath as string); },
    );
    assert.deepEqual((await handlers.listTools()).tools.map((tool) => tool.name), ["read_data"]);

    await writeMcpRuntimeDescriptors(root, resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: [],
    }));
    await assert.rejects(() => handlers.listTools(), /missing|not active/u);
    await assert.rejects(
      () => handlers.callTool({ name: "read_data", arguments: {} }),
      /missing|not active/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK stdio client connects to a mock MCP server with an allowlisted environment", async () => {
  const root = await temporaryRepository();
  const serverModule = new URL(
    "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js",
    import.meta.url,
  ).href;
  const stdioModule = new URL(
    "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
    import.meta.url,
  ).href;
  const typesModule = new URL(
    "../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js",
    import.meta.url,
  ).href;
  const mockServer = `
    import { Server } from ${JSON.stringify(serverModule)};
    import { StdioServerTransport } from ${JSON.stringify(stdioModule)};
    import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesModule)};
    const server = new Server({ name: "mock", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "read_data", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return {
        content: [{
          type: "text",
          text: process.env.MOCK_TOKEN === "allowed-secret" && process.env.UNRELATED_SECRET === undefined
            ? params.name + ":ok"
            : "environment-leaked",
        }],
      };
    });
    await server.connect(new StdioServerTransport());
  `;
  const mockConfiguration = {
    capabilities: [{ id: "data.read", risk: "L0" as const, kind: "read" }],
    mcp: {
      servers: [{
        id: "mock-stdio",
        transport: "stdio" as const,
        command: process.execPath,
        args: ["--input-type=module", "--eval", mockServer],
        cwd: ".",
        env: { MOCK_TOKEN: "WORKSPACE_MOCK_TOKEN" },
        tools: [{ name: "read_data", capability: "data.read" }],
      }],
    },
  };
  try {
    await writeFile(
      join(root, ".env"),
      "WORKSPACE_MOCK_TOKEN=allowed-secret\nUNRELATED_SECRET=hidden-secret\n",
      "utf8",
    );
    const descriptor = resolveMcpRuntime(root, mockConfiguration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    }).descriptors[0] as McpRuntimeDescriptor;
    const client = await connectMcpServer(root, descriptor, {}, 25);
    try {
      assert.deepEqual(client.secrets, ["allowed-secret"]);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["read_data"]);
      const result = await client.callTool({ name: "read_data", arguments: {} });
      assert.deepEqual(result, { content: [{ type: "text", text: "read_data:ok" }] });
      await assert.rejects(
        () => client.callTool({ name: "slow", arguments: {} }),
        /upstream MCP tool call failed/u,
      );
    } finally {
      await client.close?.();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK Streamable HTTP client connects with only configured headers", async () => {
  const root = await temporaryRepository();
  const seenHeaders: Array<{ authorization?: string; unrelated?: string }> = [];
  const httpServer = createServer(async (request, response) => {
    seenHeaders.push({
      authorization: request.headers.authorization,
      unrelated: request.headers["x-unrelated"] as string | undefined,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = new Server(
      { name: "mock-http", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "read_http", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return { content: [{ type: "text", text: `${params.name}:http-ok` }] };
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
  const address = httpServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const httpConfiguration = {
    capabilities: [{ id: "http.read", risk: "L0" as const, kind: "read" }],
    mcp: {
      servers: [{
        id: "mock-http",
        transport: "http" as const,
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "WORKSPACE_HTTP_AUTH" },
        tools: [{ name: "read_http", capability: "http.read" }],
      }],
    },
  };
  try {
    await writeFile(
      join(root, ".env"),
      "WORKSPACE_HTTP_AUTH=Bearer allowed\nX_UNRELATED=hidden\n",
      "utf8",
    );
    const descriptor = resolveMcpRuntime(root, httpConfiguration, {
      tool: "codex",
      target: "root",
      capabilities: ["http.read"],
    }).descriptors[0] as McpRuntimeDescriptor;
    const client = await connectMcpServer(root, descriptor, { X_UNRELATED: "hidden" }, 25);
    try {
      assert.deepEqual(client.secrets, ["Bearer allowed"]);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["read_http"]);
      assert.deepEqual(await client.callTool({ name: "read_http", arguments: {} }), {
        content: [{ type: "text", text: "read_http:http-ok" }],
      });
      await assert.rejects(
        () => client.callTool({ name: "slow", arguments: {} }),
        /upstream MCP tool call failed/u,
      );
      assert.ok(seenHeaders.length >= 3);
      assert.ok(seenHeaders.every((headers) => headers.authorization === "Bearer allowed"));
      assert.ok(seenHeaders.every((headers) => headers.unrelated === undefined));
    } finally {
      await client.close?.().catch(() => undefined);
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      httpServer.close((error) => error === undefined ? resolveClose() : rejectClose(error)),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor loading rejects paths outside the managed runtime and tampering", async () => {
  const root = await temporaryRepository();
  try {
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}\n", "utf8");
    await assert.rejects(() => loadMcpRuntimeDescriptor(root, outside), /managed MCP runtime/u);

    const resolved = resolveMcpRuntime(root, configuration, {
      tool: "codex",
      target: "root",
      capabilities: ["data.read"],
    });
    const [descriptorPath] = await writeMcpRuntimeDescriptors(root, resolved);
    const text = await readFile(descriptorPath as string, "utf8");
    await writeFile(descriptorPath as string, text.replace("read_data", "changed_tool"), "utf8");
    await assert.rejects(
      () => loadMcpRuntimeDescriptor(root, descriptorPath as string),
      /fingerprint/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal mcp command accepts only bridge --descriptor and keeps failures off stdout", async () => {
  const seen: string[] = [];
  const result = await runMcpCommand(
    ["bridge", "--descriptor", ".saber/runtime/mcp/codex/root/data.json"],
    {
      cwd: "/workspace",
      dependencies: {
        runBridge: async ({ descriptorPath }) => {
          seen.push(descriptorPath);
        },
      },
    },
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
  assert.deepEqual(seen, [".saber/runtime/mcp/codex/root/data.json"]);

  const invalid = await runMcpCommand(["bridge", "--descriptor", "x", "--extra"], {
    cwd: "/workspace",
  });
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /unknown flag/u);
});
