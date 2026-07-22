# MCP Lifecycle and Safe Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-scoped MCP installation, guarded MCP execution, lifecycle diagnostics, and ownership-proven uninstall for Codex, Claude Code, and OpenCode.

**Architecture:** Extend the single Saber configuration with structured MCP servers and explicit tool-to-capability mappings. A shared MCP runtime powers both a filtered stdio bridge and L2 action execution; thin adapters merge namespaced entries into native project configuration. Materialize and uninstall share one schema-versioned ownership manifest and recoverable transaction model.

**Tech Stack:** TypeScript, Node.js 20+, `@modelcontextprotocol/sdk`, `smol-toml`, `jsonc-parser`, `dotenv`, Node test runner, YAML.

---

## File Structure

- `src/lib/models.ts`, `config.ts`, `local-config.ts`, `validation.ts`, `presets.ts`: canonical schema and validation.
- `src/lib/mcp/runtime.ts`: selection, descriptors, `.env` references, risk filtering, fingerprints.
- `src/lib/mcp/client.ts`: MCP SDK stdio and Streamable HTTP clients.
- `src/lib/mcp/bridge.ts`, `src/commands/mcp.ts`: filtered MCP server exposed to AI tools.
- `src/lib/tool-configs/*.ts`: Codex, Claude Code, and OpenCode structured config adapters.
- `src/lib/materialize.ts`: manifest v3 and atomic MCP reconciliation.
- `src/lib/actions.ts`: MCP-backed L2 action execution.
- `src/lib/uninstall.ts`, `src/commands/uninstall.ts`: safe preview/apply uninstall.
- `src/commands/doctor.ts`, `convenience.ts`, `materialize.ts`, `src/cli.ts`: CLI integration.
- `tests/mcp-config.test.ts`, `mcp-bridge.test.ts`, `tool-configs.test.ts`, `uninstall.test.ts`: focused tests.

### Task 1: MCP Configuration Schema

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `src/lib/models.ts`, `src/lib/config.ts`, `src/lib/local-config.ts`, `src/lib/validation.ts`, `src/lib/presets.ts`
- Modify: `saber.yaml`, `saber.local.example.yaml`, `.env.example`
- Create: `tests/mcp-config.test.ts`
- Modify: `tests/config.test.ts`, `tests/repository-assets.test.ts`

- [ ] **Step 1: Add runtime dependencies**

```bash
npm install @modelcontextprotocol/sdk smol-toml jsonc-parser dotenv
```

Expected: the manifest and lockfile contain all four packages.

- [ ] **Step 2: Add canonical discriminated types**

```ts
export type McpToolConfig = { name: string; capability: string };
export type StdioMcpServerConfig = {
  id: string; transport: "stdio"; command: string; args: string[];
  cwd?: string; env: Record<string, string>; tools: McpToolConfig[];
};
export type HttpMcpServerConfig = {
  id: string; transport: "http"; url: string;
  headers: Record<string, string>; tools: McpToolConfig[];
};
export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;
```

Add `mcp.servers` to team and local resolved config, and `extensions.mcpServers` to personal selection.

- [ ] **Step 3: Add parser and validation tests**

Cover valid stdio/HTTP, rejected OAuth fields, personal additions, duplicate IDs/tools, transport field mixing, unknown keys, unsafe cwd/URL, unknown capability, personal L2, and obsolete schemas.

```bash
npx tsx --test tests/mcp-config.test.ts tests/config.test.ts tests/repository-assets.test.ts
```

Expected before implementation: FAIL on the new schema assertions.

- [ ] **Step 4: Implement strict schema v3/v2**

Require `saber.yaml.schemaVersion === 3` and `saber.local.yaml.schemaVersion === 2`; remove `MYSQL_MCP_COMMAND` and `IDEA_MCP_COMMAND` command-string behavior. Reject unknown fields, duplicates, invalid cross-references, and personal L2/L3 mappings.

- [ ] **Step 5: Update checked-in examples and rerun Step 3**

Expected: PASS. YAML contains Chinese comments; `.env.example` contains values only, never command strings.

### Task 2: MCP Runtime, Client, and Bridge

**Files:**
- Create: `src/lib/mcp/runtime.ts`, `src/lib/mcp/client.ts`, `src/lib/mcp/bridge.ts`
- Create: `src/commands/mcp.ts`
- Modify: `src/cli.ts`
- Create: `tests/mcp-bridge.test.ts`

- [ ] **Step 1: Test public runtime contracts**

```ts
resolveMcpRuntime(root, config, { tool, role, project, capabilities });
writeMcpRuntimeDescriptors(root, resolved);
connectMcpServer(descriptor, environment);
runMcpBridge({ descriptorPath, stdin, stdout, stderr });
```

Use SDK-backed mock stdio and Streamable HTTP servers with `read_data`, `write_data`, and `undeclared_tool`. Assert unknown, unavailable, L2, and L3 tools are hidden and rejected.

- [ ] **Step 2: Implement selection and secret-free descriptors**

Select servers from effective capabilities plus explicit personal server IDs, then filter tools independently. Descriptor JSON stores environment variable names and fingerprints, never values.

- [ ] **Step 3: Implement shared MCP SDK client**

Use `StdioClientTransport` and `StreamableHTTPClientTransport`. Load only referenced `.env` values; do not invoke a shell or log child environments.

- [ ] **Step 4: Implement filtered bridge and internal CLI**

Expose only mapped L0/L1 tools. Keep stdout protocol-only and sanitize stderr. Add `saber mcp bridge --descriptor <path>` and require the resolved path under `.saber/runtime/mcp/`.

- [ ] **Step 5: Run focused tests**

```bash
npx tsx --test tests/mcp-bridge.test.ts
```

Expected: PASS for stdio, HTTP, filtering, missing env, timeout, and redaction.

### Task 3: Native Tool Configuration Adapters

**Files:**
- Create: `src/lib/tool-configs/types.ts`, `codex.ts`, `claude.ts`, `opencode.ts`, `index.ts`
- Create: `tests/tool-configs.test.ts`

- [ ] **Step 1: Define and test the common contract**

```ts
export type ManagedMcpEntry = { id: string; value: unknown; digest: string };
export interface ToolConfigAdapter {
  readonly relativePath: string;
  inspect(text: string | undefined): ToolConfigSnapshot;
  render(snapshot: ToolConfigSnapshot, desired: ManagedMcpEntry[]): string;
  verify(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): void;
  remove(snapshot: ToolConfigSnapshot, managed: ManagedMcpEntry[]): string | null;
}
```

Test empty config, unrelated settings, user MCP entries, managed updates, unowned `saber--` collisions, malformed input, and exact removal.

- [ ] **Step 2: Implement Codex adapter**

Use structured TOML. Manage only `mcp_servers["saber--<id>"]`; every entry starts the filtered Saber bridge.

- [ ] **Step 3: Implement Claude and OpenCode adapters**

Claude manages `mcpServers` in `.mcp.json`. OpenCode manages `mcp` in `opencode.json` using JSONC edits so unrelated comments survive. Both use the same namespace and ownership checks.

- [ ] **Step 4: Run adapter tests**

```bash
npx tsx --test tests/tool-configs.test.ts
```

Expected: PASS for all tools without changing non-Saber entries.

### Task 4: Materialize MCP Transaction and Manifest v3

**Files:**
- Modify: `src/lib/materialize.ts`
- Modify: `src/commands/materialize.ts`, `src/commands/convenience.ts`
- Modify: `tests/materialize.test.ts`, `tests/convenience.test.ts`

- [ ] **Step 1: Add manifest and rollback tests**

Assert exact native config state, MCP entries, descriptors, projections, source fingerprints, nested project targets, and fault-injected rollback after native config replacement.

- [ ] **Step 2: Replace manifest schema v2 with v3**

Delete schema v2 parsing. Strictly validate `managedBy`, tool/target, managed-root paths, projections, MCP entry digests, descriptor digests, and config source fingerprints.

- [ ] **Step 3: Integrate MCP reconciliation**

Build descriptors and native entries from effective role/project capabilities. Stage config and runtime files, snapshot previous state, promote atomically, and write the manifest last. Recover interrupted transactions before another lifecycle write.

- [ ] **Step 4: Update output and run tests**

Report MCP IDs separately from capabilities and never show secrets.

```bash
npx tsx --test tests/materialize.test.ts tests/convenience.test.ts
```

Expected: PASS for roots, projects, role changes, merges, and rollback.

### Task 5: L2 MCP Action Executor

**Files:**
- Modify: `src/lib/actions.ts`, `src/commands/action.ts`
- Modify: `skills/saber/SKILL.md`
- Modify: `tests/actions.test.ts`

- [ ] **Step 1: Add safe MCP action tests**

Cover unique capability mapping, preview redaction, token binding to server/tool/arguments/config digest, confirmed single execution, missing/duplicate mapping, drift, uncertain reconciliation, and direct bridge denial.

- [ ] **Step 2: Implement MCP action resolution and preview**

Resolve exactly one configured server/tool for the capability. Canonicalize arguments and bind server, tool, destination, arguments, and current configuration digest into the confirmation token.

- [ ] **Step 3: Implement execution through the shared client**

After token verification, verify the upstream tool exists, invoke once, and reconcile through an available read capability. Return an explicit uncertain result instead of retrying blindly.

- [ ] **Step 4: Update `/saber` routing and run tests**

Route L2 MCP writes through action preview/confirm; use native L0/L1 tools directly.

```bash
npx tsx --test tests/actions.test.ts
```

Expected: PASS with no L2/L3 native bypass.

### Task 6: Ownership-Proven Uninstall

**Files:**
- Create: `src/lib/uninstall.ts`, `src/commands/uninstall.ts`
- Modify: `src/cli.ts`
- Create: `tests/uninstall.test.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Test scope, ownership, tokens, and rollback**

Cover `--tool`, optional `--project`, `--all`, invalid combinations, empty plans, replaced links, changed files/entries, malformed manifests, path escapes, stale tokens, multi-target preflight failure, write failure, recovery, and repeated uninstall.

- [ ] **Step 2: Implement a deterministic plan with a single-use preview token**

Read only selected manifest v3 files. Produce a sorted plan of exact paths, native keys, current digests, preserved resources, and conflicts. Issue a random nonce-backed preview record for that plan; never infer ownership by scanning prefixes.

- [ ] **Step 3: Implement exact confirmation and recoverable apply**

Bind the single-use token to a random nonce, canonical plan, target set, and source digests. Require `--apply --confirm <token>`, consume it atomically, preflight every target, snapshot all affected files, remove verified entries, and roll back all targets on failure.

- [ ] **Step 4: Preserve non-owned state and run tests**

Keep external cache, source assets, projects, unrelated tool settings, and OAuth tokens. Delete native config only when the manifest proves Saber created it and it becomes empty.

```bash
npx tsx --test tests/uninstall.test.ts tests/cli.test.ts
```

Expected: PASS for targeted, all, idempotent, conflict, and rollback behavior.

### Task 7: Doctor, Documentation, and Final Acceptance

**Files:**
- Modify: `src/commands/doctor.ts`, `README.md`
- Modify: `tests/commands.test.ts`, `tests/acceptance.test.ts`

- [ ] **Step 1: Add and implement doctor states**

Cover missing env, command/build, invalid descriptor, native config drift, pending trust/restart, rejected OAuth, unresolved transaction, and safe L2 routing. Doctor remains read-only and never claims a real connection from config alone.

- [ ] **Step 2: Add three-tool lifecycle acceptance**

In temporary root and nested project Git repositories, materialize Codex/Claude/OpenCode, inspect native config and descriptors, switch roles, preview and apply targeted uninstall, then apply `--all`.

- [ ] **Step 3: Simplify Chinese README**

Keep core capabilities, setup, structured MCP example, `use`, `doctor`, targeted/all uninstall, `/saber`, and verification commands.

- [ ] **Step 4: Run final verification after functional completion**

```bash
npm test
npm run check
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Run CLI smoke tests**

```bash
npm run saber -- validate --json
npm run saber -- doctor --json
npm run saber -- materialize --tool codex --role ba --json
npm run saber -- uninstall --tool codex --json
```

Expected: valid JSON, no secret values, and uninstall remains preview-only.

- [ ] **Step 6: Review and commit implementation**

```bash
git status --short --branch
git diff --stat
git diff --check
git add package.json package-lock.json src tests skills/saber/SKILL.md saber.yaml saber.local.example.yaml .env.example README.md
git commit -m "feat: add managed MCP lifecycle and safe uninstall"
```
