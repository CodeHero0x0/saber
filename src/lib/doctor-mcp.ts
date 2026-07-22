import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseRuntimeManifest, type RuntimeManifest } from "./materialize-manifest.js";
import { loadMcpActiveIndex } from "./mcp/runtime.js";
import type { McpServerConfig, RepositoryConfig, RiskLevel, ToolName } from "./models.js";
import { toolConfigAdapters } from "./tool-configs/index.js";

export type McpDoctorServer = {
  id: string;
  transport: McpServerConfig["transport"];
  state: "valid" | "invalid";
  environment: { state: "available" | "missing"; missing: string[] };
  command?: { state: "available" | "missing" };
  cwd?: { state: "available" | "missing" | "outside-repository" };
  url?: { state: "valid" };
  tools: Array<{
    name: string;
    capability: string;
    risk: RiskLevel | "unknown";
    route: "native" | "action-gateway" | "forbidden";
  }>;
};

export type McpDoctorTarget = {
  tool: ToolName;
  target: string;
  project: string | null;
  state: "valid" | "invalid";
  issues: string[];
};

export type McpDoctorReport = {
  servers: McpDoctorServer[];
  clients: Array<{
    name: ToolName;
    trust: "pending" | "unknown";
    restart: "pending" | "unknown";
  }>;
  runtime: {
    targets: McpDoctorTarget[];
    transactions: {
      state: "clear" | "unresolved";
      entries: string[];
    };
  };
  policy: {
    oauth: "unsupported";
    l2: "action-gateway";
    l3: "forbidden";
  };
};

const toolNames: readonly ToolName[] = ["codex", "claude", "opencode"];
const safeTarget = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT"
      || (error as { code?: unknown }).code === "ENOTDIR");
}

function rawDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

async function pathState(
  repositoryRoot: string,
  path: string,
): Promise<"available" | "missing" | "outside-repository"> {
  const candidate = resolve(repositoryRoot, path);
  try {
    const status = await lstat(candidate);
    if (!status.isDirectory()) return "missing";
    const [root, canonical] = await Promise.all([realpath(repositoryRoot), realpath(candidate)]);
    return isWithin(root, canonical) ? "available" : "outside-repository";
  } catch {
    return "missing";
  }
}

async function executableAvailable(
  repositoryRoot: string,
  command: string,
  cwd: string,
  searchPath: string | undefined,
): Promise<boolean> {
  const childCwd = resolve(repositoryRoot, cwd);
  const candidates = command.includes("/") || command.includes("\\")
    ? [resolve(childCwd, command)]
    : searchPath === undefined
      ? []
      : searchPath
        .split(delimiter)
        .map((entry) => resolve(
          entry.length === 0 ? childCwd : isAbsolute(entry) ? entry : resolve(childCwd, entry),
          command,
        ));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const status = await lstat(canonical);
      if (!status.isFile()) continue;
      if (command.includes("/") || command.includes("\\")) {
        const root = await realpath(repositoryRoot);
        if (!isWithin(root, canonical)) continue;
      }
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH without starting the configured executable.
    }
  }
  return false;
}

function routeFor(risk: RiskLevel | "unknown"): McpDoctorServer["tools"][number]["route"] {
  if (risk === "L2") return "action-gateway";
  if (risk === "L3" || risk === "unknown") return "forbidden";
  return "native";
}

async function inspectServer(
  repositoryRoot: string,
  server: McpServerConfig,
  risks: ReadonlyMap<string, RiskLevel>,
  environment: Readonly<Record<string, string | undefined>>,
  processEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<McpDoctorServer> {
  const references = Object.values(server.transport === "stdio" ? server.env : server.headers);
  const missing = [...new Set(references.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim().length === 0;
  }))].sort();
  const tools = server.tools.map((tool) => {
    const risk: RiskLevel | "unknown" = risks.get(tool.capability) ?? "unknown";
    return { ...tool, risk, route: routeFor(risk) };
  });
  if (server.transport === "http") {
    return {
      id: server.id,
      transport: server.transport,
      state: missing.length === 0 ? "valid" : "invalid",
      environment: { state: missing.length === 0 ? "available" : "missing", missing },
      url: { state: "valid" },
      tools,
    };
  }

  const [commandAvailable, cwd] = await Promise.all([
    executableAvailable(
      repositoryRoot,
      server.command,
      server.cwd ?? ".",
      server.env.PATH === undefined
        ? processEnvironment.PATH
        : environment[server.env.PATH],
    ),
    pathState(repositoryRoot, server.cwd ?? "."),
  ]);
  return {
    id: server.id,
    transport: server.transport,
    state: missing.length === 0 && commandAvailable && cwd === "available" ? "valid" : "invalid",
    environment: { state: missing.length === 0 ? "available" : "missing", missing },
    command: { state: commandAvailable ? "available" : "missing" },
    cwd: { state: cwd },
    tools,
  };
}

async function workspaceEnvironment(repositoryRoot: string): Promise<Record<string, string>> {
  const text = await readRegularFile(join(repositoryRoot, ".env"));
  if (text === undefined) return {};
  try {
    const { parse } = await import("dotenv");
    return parse(text);
  } catch {
    // A malformed local file must not cause source text or parser errors to enter diagnostics.
    return {};
  }
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) return undefined;
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    return undefined;
  }
}

function expectedToolConfigPath(config: RepositoryConfig, manifest: RuntimeManifest): string | undefined {
  const adapterPath = toolConfigAdapters[manifest.tool].relativePath.replaceAll("\\", "/");
  if (manifest.project === null) return adapterPath;
  const project = config.workspace.projects.find(({ name }) => name === manifest.project);
  if (project === undefined) return undefined;
  return `${project.path.replaceAll("\\", "/")}/${adapterPath}`;
}

async function inspectTarget(
  repositoryRoot: string,
  config: RepositoryConfig,
  tool: ToolName,
  filename: string,
): Promise<McpDoctorTarget> {
  const rawTarget = filename.slice(0, -".json".length);
  const targetFromPath = safeTarget.test(rawTarget) ? rawTarget : "unknown";
  const manifestPath = join(repositoryRoot, ".saber", "runtime", "materialize", tool, filename);
  const text = await readRegularFile(manifestPath);
  let manifest: RuntimeManifest;
  try {
    if (text === undefined) throw new Error("missing");
    manifest = parseRuntimeManifest(text);
  } catch {
    return {
      tool,
      target: targetFromPath,
      project: targetFromPath === "root" ? null : targetFromPath,
      state: "invalid",
      issues: ["manifest-invalid"],
    };
  }

  const issues = new Set<string>();
  const expectedTarget = manifest.project ?? "root";
  if (manifest.tool !== tool || manifest.target !== expectedTarget || targetFromPath !== expectedTarget) {
    issues.add("manifest-target-mismatch");
  }

  const expectedIndexPath = `.saber/runtime/mcp/${tool}/${manifest.target}/_active.json`;
  const activeText = manifest.activeIndex.path === expectedIndexPath
    ? await readRegularFile(resolve(repositoryRoot, manifest.activeIndex.path))
    : undefined;
  if (activeText === undefined || rawDigest(activeText) !== manifest.activeIndex.digest) {
    issues.add("active-index-drift");
  }
  try {
    const index = await loadMcpActiveIndex(repositoryRoot, manifest.tool, manifest.target);
    const indexed = new Map(index.descriptors.map((entry) => [entry.file, entry]));
    if (
      indexed.size !== manifest.descriptors.length
      || manifest.descriptors.some((descriptor) => {
        const entry = indexed.get(`${descriptor.id}.json`);
        return entry === undefined
          || entry.descriptorFingerprint !== descriptor.descriptorFingerprint
          || entry.sourceFingerprint !== descriptor.sourceFingerprint;
      })
    ) {
      issues.add("active-index-drift");
    }
  } catch {
    issues.add("active-index-drift");
  }

  for (const descriptor of manifest.descriptors) {
    const expectedPath = `.saber/runtime/mcp/${tool}/${manifest.target}/${descriptor.id}.json`;
    const descriptorText = descriptor.path === expectedPath
      ? await readRegularFile(resolve(repositoryRoot, descriptor.path))
      : undefined;
    let consistent = descriptorText !== undefined && rawDigest(descriptorText) === descriptor.digest;
    if (descriptorText !== undefined) {
      try {
        const value = JSON.parse(descriptorText) as {
          tool?: unknown;
          target?: unknown;
          server?: { id?: unknown };
          descriptorFingerprint?: unknown;
          sourceFingerprint?: unknown;
        };
        consistent = consistent
          && value.tool === manifest.tool
          && value.target === manifest.target
          && value.server?.id === descriptor.id
          && value.descriptorFingerprint === descriptor.descriptorFingerprint
          && value.sourceFingerprint === descriptor.sourceFingerprint;
      } catch {
        consistent = false;
      }
    }
    if (!consistent) issues.add(`descriptor-drift:${descriptor.id}`);
  }

  const expectedConfigPath = expectedToolConfigPath(config, manifest);
  const toolConfigText = expectedConfigPath === manifest.toolConfig.path
    ? await readRegularFile(resolve(repositoryRoot, manifest.toolConfig.path))
    : undefined;
  let nativeValid = expectedConfigPath === manifest.toolConfig.path;
  try {
    const adapter = toolConfigAdapters[manifest.tool];
    adapter.verify(adapter.inspect(toolConfigText), manifest.mcpEntries);
  } catch {
    nativeValid = false;
  }
  if (!nativeValid) issues.add("native-config-drift");

  for (const projection of manifest.projections.filter(({ kind }) => kind === "context")) {
    const contextText = await readRegularFile(resolve(repositoryRoot, projection.sourcePath, "SKILL.md"));
    if (
      projection.sourceDigest === null
      || contextText === undefined
      || rawDigest(contextText) !== projection.sourceDigest
    ) {
      issues.add("context-runtime-drift");
    }
  }

  return {
    tool: manifest.tool,
    target: manifest.target,
    project: manifest.project,
    state: issues.size === 0 ? "valid" : "invalid",
    issues: [...issues].sort(),
  };
}

async function inspectTargets(
  repositoryRoot: string,
  config: RepositoryConfig,
): Promise<McpDoctorTarget[]> {
  const targets: McpDoctorTarget[] = [];
  for (const tool of toolNames) {
    const components = [".saber", "runtime", "materialize", tool];
    let directory = repositoryRoot;
    let entries: string[];
    try {
      for (const component of components) {
        directory = join(directory, component);
        const status = await lstat(directory);
        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw new Error("unsafe-directory");
        }
      }
      entries = await readdir(directory);
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      targets.push({
        tool,
        target: "unknown",
        project: null,
        state: "invalid",
        issues: [
          error instanceof Error && error.message === "unsafe-directory"
            ? "manifest-directory-invalid"
            : "manifest-directory-unreadable",
        ],
      });
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      targets.push(await inspectTarget(repositoryRoot, config, tool, entry));
    }
  }
  return targets;
}

async function inspectTransactions(repositoryRoot: string): Promise<McpDoctorReport["runtime"]["transactions"]> {
  const directory = join(repositoryRoot, ".saber", "runtime", "transactions");
  try {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      return { state: "unresolved", entries: ["unsafe-transaction-directory"] };
    }
    const entries = (await readdir(directory)).sort().map((entry) =>
      entry === "uninstall.json"
        || /^materialize--(?:codex|claude|opencode)--[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(entry)
        ? entry
        : "unknown-transaction");
    return { state: entries.length === 0 ? "clear" : "unresolved", entries };
  } catch (error: unknown) {
    if (isMissing(error)) return { state: "clear", entries: [] };
    return { state: "unresolved", entries: ["unreadable-transaction-directory"] };
  }
}

/** Inspect MCP configuration and generated state without executing servers or changing local files. */
export async function inspectMcpDoctor(
  repositoryRoot: string,
  config: RepositoryConfig | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<McpDoctorReport> {
  const fileEnvironment = await workspaceEnvironment(repositoryRoot);
  const effectiveEnvironment: Record<string, string | undefined> = { ...fileEnvironment };
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) effectiveEnvironment[name] = value;
  }
  const servers = config === undefined
    ? []
    : await Promise.all(
      [...config.mcp.servers, ...(config.local?.mcp.servers ?? [])].map((server) =>
        inspectServer(
          repositoryRoot,
          server,
          new Map(config.capabilities.map(({ id, risk }) => [id, risk])),
          effectiveEnvironment,
          environment,
        )),
    );
  const targets = config === undefined ? [] : await inspectTargets(repositoryRoot, config);
  const pendingTools = new Set(
    targets.filter(({ target }) => target !== "unknown").map(({ tool }) => tool),
  );
  return {
    servers,
    clients: toolNames.map((name) => ({
      name,
      trust: pendingTools.has(name) ? "pending" : "unknown",
      restart: pendingTools.has(name) ? "pending" : "unknown",
    })),
    runtime: {
      targets,
      transactions: await inspectTransactions(repositoryRoot),
    },
    policy: { oauth: "unsupported", l2: "action-gateway", l3: "forbidden" },
  };
}
