import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeToolConfig,
  codexToolConfig,
  createManagedMcpEntry,
  digestMcpValue,
  opencodeToolConfig,
  toolConfigAdapters,
  type ToolConfigAdapter,
} from "../src/lib/tool-configs/index.js";
import { SaberError } from "../src/lib/errors.js";

const bridge = {
  command: "node",
  args: ["tools/idea-mcp.js"],
};

const updatedBridge = {
  command: "node",
  args: ["tools/idea-mcp-v2.js"],
};

function adapters(): Array<[string, ToolConfigAdapter]> {
  return [
    ["codex", codexToolConfig],
    ["claude", claudeToolConfig],
    ["opencode", opencodeToolConfig],
  ];
}

test("adapter registry exposes the three project-level configuration paths", () => {
  assert.equal(toolConfigAdapters.codex.relativePath, ".codex/config.toml");
  assert.equal(toolConfigAdapters.claude.relativePath, ".mcp.json");
  assert.equal(toolConfigAdapters.opencode.relativePath, "opencode.json");
});

for (const [name, adapter] of adapters()) {
  test(`${name} renders and verifies a managed entry from an empty configuration`, () => {
    const desired = createManagedMcpEntry("saber--idea", bridge);
    const rendered = adapter.render(adapter.inspect(undefined), [desired]);
    const snapshot = adapter.inspect(rendered);

    adapter.verify(snapshot, [createManagedMcpEntry("saber--idea", {
      args: [...bridge.args],
      command: bridge.command,
    })]);
    assert.deepEqual(snapshot.entries["saber--idea"], bridge);
  });

  test(`${name} preserves user settings and user MCP entries`, () => {
    const source = sourceWithUserContent(name);
    const rendered = adapter.render(
      adapter.inspect(source),
      [createManagedMcpEntry("saber--idea", bridge)],
    );
    const snapshot = adapter.inspect(rendered);

    assert.deepEqual(snapshot.entries.user, { command: "user-mcp", args: ["--keep"] });
    assertUserSetting(name, snapshot.config);
  });

  test(`${name} supports a manifest-proven managed update`, () => {
    const original = createManagedMcpEntry("saber--idea", bridge);
    const first = adapter.render(adapter.inspect(undefined), [original]);
    const installed = adapter.inspect(first);
    adapter.verify(installed, [original]);

    const removed = adapter.remove(installed, [original]);
    const updated = adapter.render(
      adapter.inspect(removed ?? undefined),
      [createManagedMcpEntry("saber--idea", updatedBridge)],
    );

    adapter.verify(adapter.inspect(updated), [createManagedMcpEntry("saber--idea", updatedBridge)]);
  });

  test(`${name} refuses to take over an unowned saber namespace collision`, () => {
    const collision = sourceWithCollision(name);
    assert.throws(
      () => adapter.render(
        adapter.inspect(collision),
        [createManagedMcpEntry("saber--idea", bridge)],
      ),
      (error: unknown) => error instanceof SaberError && /ownership conflict/u.test(error.message),
    );
  });

  test(`${name} refuses an unowned collision even when its value is identical`, () => {
    const desired = createManagedMcpEntry("saber--idea", bridge);
    const installed = adapter.render(adapter.inspect(undefined), [desired]);
    assert.throws(
      () => adapter.render(adapter.inspect(installed), [desired]),
      (error: unknown) => error instanceof SaberError && /ownership conflict/u.test(error.message),
    );
  });

  test(`${name} rejects malformed configuration`, () => {
    const malformed = name === "codex" ? "[mcp_servers\ninvalid" : "{ invalid";
    assert.throws(
      () => adapter.inspect(malformed),
      (error: unknown) => error instanceof SaberError && /invalid/u.test(error.message),
    );
  });

  test(`${name} verifies normalized values exactly`, () => {
    const desired = createManagedMcpEntry("saber--idea", bridge);
    const rendered = adapter.render(adapter.inspect(undefined), [desired]);

    assert.doesNotThrow(() => adapter.verify(adapter.inspect(rendered), [desired]));
    assert.throws(
      () => adapter.verify(
        adapter.inspect(rendered),
        [createManagedMcpEntry("saber--idea", updatedBridge)],
      ),
      (error: unknown) => error instanceof SaberError && /does not match/u.test(error.message),
    );
  });

  test(`${name} removes only exact manifest entries and refuses tampering`, () => {
    const first = createManagedMcpEntry("saber--idea", bridge);
    const second = createManagedMcpEntry("saber--mysql", { command: "mysql-bridge" });
    const installed = adapter.render(adapter.inspect(sourceWithUserContent(name)), [first, second]);

    const afterFirstRemoval = adapter.remove(adapter.inspect(installed), [first]);
    assert.ok(afterFirstRemoval !== null);
    const remaining = adapter.inspect(afterFirstRemoval);
    assert.deepEqual(remaining.entries.user, { command: "user-mcp", args: ["--keep"] });
    assert.deepEqual(remaining.entries["saber--mysql"], { command: "mysql-bridge" });
    assert.equal(remaining.entries["saber--idea"], undefined);

    assert.throws(
      () => adapter.remove(remaining, [createManagedMcpEntry("saber--mysql", { command: "tampered" })]),
      (error: unknown) => error instanceof SaberError && /does not match/u.test(error.message),
    );
  });
}

test("managed entries centrally enforce the saber namespace and digest", () => {
  assert.throws(
    () => createManagedMcpEntry("user", bridge),
    (error: unknown) => error instanceof SaberError && /saber--/u.test(error.message),
  );

  const desired = createManagedMcpEntry("saber--idea", bridge);
  assert.throws(
    () => codexToolConfig.render(codexToolConfig.inspect(undefined), [{ ...desired, digest: "bad" }]),
    (error: unknown) => error instanceof SaberError && /digest/u.test(error.message),
  );
});

test("nested __proto__ keys cannot collide with an empty object digest or bypass removal checks", () => {
  const cleanValue = { command: "node", env: {} };
  const pollutedValue = JSON.parse(
    '{"command":"node","env":{"__proto__":{"TOKEN":"changed"}}}',
  ) as unknown;
  assert.notEqual(digestMcpValue(cleanValue), digestMcpValue(pollutedValue));

  const managed = createManagedMcpEntry("saber--idea", cleanValue);
  const tampered = claudeToolConfig.inspect(`${JSON.stringify({
    mcpServers: { "saber--idea": pollutedValue },
  })}\n`);
  assert.throws(
    () => claudeToolConfig.verify(tampered, [managed]),
    (error: unknown) => error instanceof SaberError && /does not match/u.test(error.message),
  );
  assert.throws(
    () => claudeToolConfig.remove(tampered, [managed]),
    (error: unknown) => error instanceof SaberError && /does not match/u.test(error.message),
  );
});

test("Codex and Claude parser errors never echo configuration secrets", () => {
  const secret = "SABER_SECRET_DO_NOT_ECHO";
  for (const [adapter, malformed] of [
    [codexToolConfig, `secret = "${secret}`],
    [claudeToolConfig, `{"${secret}": @`],
  ] as const) {
    assert.throws(
      () => adapter.inspect(malformed),
      (error: unknown) => error instanceof SaberError
        && /invalid/u.test(error.message)
        && !error.message.includes(secret),
    );
  }
});

test("Codex add and remove preserve every non-Saber source byte", () => {
  const source = `# Keep spelling, comments, order, and float syntax.
model = "gpt-5"
temperature = 1.0 # must remain a float

[mcp_servers.user]
command = "user-mcp"
args = [ "--keep" ]
`;
  const desired = createManagedMcpEntry("saber--idea", bridge);

  const rendered = codexToolConfig.render(codexToolConfig.inspect(source), [desired]);
  assert.ok(rendered.startsWith(`${source}\n`));
  assert.match(rendered, /saber-managed-mcp-begin/u);

  const removed = codexToolConfig.remove(codexToolConfig.inspect(rendered), [desired]);
  assert.equal(removed, source);
});

test("Codex removal fails closed when its exact managed block marker is missing", () => {
  const desired = createManagedMcpEntry("saber--idea", bridge);
  const rendered = codexToolConfig.render(codexToolConfig.inspect("model = \"gpt-5\"\n"), [desired]);
  const markerless = rendered.replace(/^# saber-managed-mcp-begin.*\n/mu, "");

  assert.throws(
    () => codexToolConfig.remove(codexToolConfig.inspect(markerless), [desired]),
    (error: unknown) => error instanceof SaberError && /managed block/u.test(error.message),
  );
});

test("Codex rejects inline MCP containers before rendering without echoing their contents", () => {
  const secret = "INLINE_SECRET_DO_NOT_ECHO";
  for (const source of [
    "mcp_servers = {}\n",
    `mcp_servers = { user = { command = "${secret}" } }\n`,
    `"mcp_servers" = { user = { command = "${secret}" } }\n`,
  ]) {
    assert.throws(
      () => codexToolConfig.inspect(source),
      (error: unknown) => error instanceof SaberError
        && /inline mcp_servers.*not supported/u.test(error.message)
        && !error.message.includes(secret),
    );
  }
});

test("Codex still accepts an explicit MCP table that can be extended safely", () => {
  const source = `[mcp_servers]
user = { command = "keep" }
`;
  const desired = createManagedMcpEntry("saber--idea", bridge);
  const rendered = codexToolConfig.render(codexToolConfig.inspect(source), [desired]);

  assert.doesNotThrow(() => codexToolConfig.verify(codexToolConfig.inspect(rendered), [desired]));
  assert.equal(codexToolConfig.remove(codexToolConfig.inspect(rendered), [desired]), source);
});

for (const [name, adapter, container] of [
  ["Claude", claudeToolConfig, "mcpServers"],
  ["OpenCode", opencodeToolConfig, "mcp"],
] as const) {
  test(`${name} rejects duplicate target containers`, () => {
    assert.throws(
      () => adapter.inspect(`{"${container}":{},"${container}":{}}`),
      (error: unknown) => error instanceof SaberError && /duplicate/u.test(error.message),
    );
  });

  test(`${name} rejects duplicate MCP entry keys`, () => {
    assert.throws(
      () => adapter.inspect(`{"${container}":{"saber--idea":{},"saber--idea":{}}}`),
      (error: unknown) => error instanceof SaberError && /duplicate/u.test(error.message),
    );
  });
}

test("OpenCode preserves JSONC comments while editing MCP entries", () => {
  const source = `{
  // Keep this user note.
  "theme": "system",
  "mcp": {
    // Keep this user server note.
    "user": { "command": "user-mcp", "args": ["--keep"] }
  }
}\n`;

  const rendered = opencodeToolConfig.render(
    opencodeToolConfig.inspect(source),
    [createManagedMcpEntry("saber--idea", bridge)],
  );
  const removed = opencodeToolConfig.remove(
    opencodeToolConfig.inspect(rendered),
    [createManagedMcpEntry("saber--idea", bridge)],
  );

  assert.match(rendered, /Keep this user note/u);
  assert.match(rendered, /Keep this user server note/u);
  assert.ok(removed !== null);
  assert.match(removed, /Keep this user note/u);
  assert.match(removed, /Keep this user server note/u);
});

test("OpenCode keeps an empty MCP container when removing it would lose user comments", () => {
  const source = `{
  // Keep the note attached to the MCP container.
  "mcp": {
    // Keep the note inside the MCP container.
  }
}\n`;
  const desired = createManagedMcpEntry("saber--idea", bridge);
  const rendered = opencodeToolConfig.render(opencodeToolConfig.inspect(source), [desired]);

  const removed = opencodeToolConfig.remove(opencodeToolConfig.inspect(rendered), [desired]);

  assert.ok(removed !== null);
  assert.match(removed, /Keep the note attached to the MCP container/u);
  assert.match(removed, /Keep the note inside the MCP container/u);
  assert.deepEqual(opencodeToolConfig.inspect(removed).config.mcp, {});
});

test("OpenCode refuses to remove one managed entry when its adjacent user comment would be lost", () => {
  const desired = createManagedMcpEntry("saber--idea", bridge);
  const rendered = opencodeToolConfig.render(
    opencodeToolConfig.inspect('{"mcp":{"user":{"command":"keep"}}}\n'),
    [desired],
  );
  const commented = rendered.replace(
    '"saber--idea"',
    '// Keep this user note beside the managed entry.\n    "saber--idea"',
  );

  assert.throws(
    () => opencodeToolConfig.remove(opencodeToolConfig.inspect(commented), [desired]),
    (error: unknown) => error instanceof SaberError && /comment/u.test(error.message),
  );
});

test("remove returns null when the last managed entry leaves an empty configuration", () => {
  for (const [, adapter] of adapters()) {
    const desired = createManagedMcpEntry("saber--idea", bridge);
    const rendered = adapter.render(adapter.inspect(undefined), [desired]);
    assert.equal(adapter.remove(adapter.inspect(rendered), [desired]), null);
  }
});

function sourceWithUserContent(name: string): string {
  if (name === "codex") {
    return `model = "gpt-5"\n\n[mcp_servers.user]\ncommand = "user-mcp"\nargs = ["--keep"]\n`;
  }
  const key = name === "claude" ? "mcpServers" : "mcp";
  return `${JSON.stringify({ theme: "system", [key]: { user: { command: "user-mcp", args: ["--keep"] } } }, null, 2)}\n`;
}

function sourceWithCollision(name: string): string {
  if (name === "codex") {
    return `[mcp_servers.saber--idea]\ncommand = "user-owned"\n`;
  }
  const key = name === "claude" ? "mcpServers" : "mcp";
  return `${JSON.stringify({ [key]: { "saber--idea": { command: "user-owned" } } }, null, 2)}\n`;
}

function assertUserSetting(name: string, config: Record<string, unknown>): void {
  if (name === "codex") {
    assert.equal(config.model, "gpt-5");
  } else {
    assert.equal(config.theme, "system");
  }
}
