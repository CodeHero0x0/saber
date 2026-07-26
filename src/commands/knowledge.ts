import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import { resolveKnowledge, validateKnowledgeAssets } from "../lib/knowledge.js";

export type KnowledgeCommandResult = { exitCode: number; stdout: string; stderr: string };
export type KnowledgeCommandDependencies = { loadConfig?: typeof loadRepositoryConfig };

type Options = { positionals: string[]; values: Map<string, string[]>; flags: Set<string> };
type Request =
  | { action: "validate"; json: boolean }
  | { action: "resolve"; repositories: string[]; modules: string[]; subjects: string[]; ids: string[]; limit: number; json: boolean };

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseOptions(argv: readonly string[], valueFlags: readonly string[]): Options {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (flags.has(argument)) throw new SaberError("duplicate flag --json", 2);
      flags.add(argument);
    } else if (argument?.startsWith("--")) {
      if (!valueFlags.includes(argument)) throw new SaberError("unknown flag", 2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new SaberError(`${argument} requires a value`, 2);
      values.set(argument, [...(values.get(argument) ?? []), value]);
      index += 1;
    } else if (argument?.startsWith("-")) {
      throw new SaberError("unknown flag", 2);
    } else if (argument !== undefined) {
      positionals.push(argument);
    }
  }
  return { positionals, values, flags };
}

function parseRequest(argv: readonly string[]): Request {
  const action = argv[0];
  if (action !== "validate" && action !== "resolve") throw new SaberError("knowledge requires validate or resolve", 2);
  const options = parseOptions(argv.slice(1), action === "resolve"
    ? ["--repository", "--module", "--subject", "--id", "--limit"]
    : []);
  if (options.positionals.length > 0) throw new SaberError(`knowledge ${action} accepts no positional arguments`, 2);
  if (action === "validate") return { action, json: options.flags.has("--json") };
  const repositories = options.values.get("--repository") ?? [];
  if (repositories.length === 0) throw new SaberError("knowledge resolve requires at least one --repository", 2);
  const rawLimit = options.values.get("--limit") ?? ["5"];
  if (rawLimit.length !== 1 || !/^(?:[1-9]|1[0-9]|20)$/u.test(rawLimit[0]!)) {
    throw new SaberError("--limit must be an integer from 1 to 20", 2);
  }
  return {
    action,
    repositories,
    modules: options.values.get("--module") ?? [],
    subjects: options.values.get("--subject") ?? [],
    ids: options.values.get("--id") ?? [],
    limit: Number(rawLimit[0]),
    json: options.flags.has("--json"),
  };
}

function formatResolution(value: Awaited<ReturnType<typeof resolveKnowledge>>): string {
  const entries = value.entries.length === 0
    ? "- none"
    : value.entries.map((entry) => `- ${entry.id} (${entry.reason}): ${entry.path}`).join("\n");
  const customerSources = value.customerSources.length === 0
    ? "- none"
    : value.customerSources.map((source) => `- ${source.repository}:${source.path} (${source.reason})`).join("\n");
  const risks = value.risks.length === 0
    ? "- none"
    : value.risks.map((risk) => `- ${risk.code}: ${risk.entryId} (${risk.source})`).join("\n");
  const uncovered = value.uncovered.length === 0 ? "- none" : value.uncovered.map((term) => `- ${term}`).join("\n");
  return `Knowledge entries:\n${entries}\nCustomer rules to read:\n${customerSources}\nRisks:\n${risks}\nUncovered:\n${uncovered}\n`;
}

/** Resolve only paths/reasons/risks; callers read selected Markdown explicitly if the user proceeds. */
export async function runKnowledgeCommand(
  argv: readonly string[],
  { cwd, dependencies = {} }: { cwd: string; dependencies?: KnowledgeCommandDependencies },
): Promise<KnowledgeCommandResult> {
  const jsonRequested = argv.includes("--json");
  try {
    const request = parseRequest(argv);
    if (request.action === "validate") {
      const errors = await validateKnowledgeAssets(cwd);
      const report = { valid: errors.length === 0, errors };
      return { exitCode: report.valid ? 0 : 2, stdout: request.json ? asJson(report) : report.valid ? "Knowledge validation passed.\n" : `Knowledge validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`, stderr: "" };
    }
    const config = await (dependencies.loadConfig ?? loadRepositoryConfig)(cwd);
    const repositoryPaths = request.repositories.map((id) => {
      const project = config.workspace.projects.find((candidate) => candidate.name === id);
      if (project === undefined) throw new SaberError(`unknown project ${id}`, 2);
      return { id, path: project.path };
    });
    const resolution = await resolveKnowledge(cwd, { ...request, repositoryPaths });
    return {
      exitCode: resolution.risks.length === 0 ? 0 : 2,
      stdout: request.json ? asJson(resolution) : formatResolution(resolution),
      stderr: "",
    };
  } catch (error: unknown) {
    const message = error instanceof SaberError ? error.message : "knowledge command failed";
    const exitCode = error instanceof SaberError ? error.exitCode : 1;
    return jsonRequested ? { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" } : { exitCode, stdout: "", stderr: `${message}\n` };
  }
}
