import {
  createActionPreview,
  executeAction,
  loadActionPayload,
  type ActionExecution,
  type ActionPreview,
} from "../lib/actions.js";
import { loadRepositoryConfig } from "../lib/config.js";
import { SaberError } from "../lib/errors.js";
import type { HttpFetch } from "../lib/http.js";
import type { Capability, RepositoryConfig } from "../lib/models.js";
import { validateRepositoryConfig } from "../lib/validation.js";

export type ActionCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ActionCommandDependencies = {
  loadConfig?: (repositoryRoot: string) => Promise<RepositoryConfig>;
  /** Injected only for local tests; production reads the caller's environment at execution time. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: HttpFetch;
};

type ParsedOptions = {
  positionals: string[];
  values: ReadonlyMap<string, string>;
  json: boolean;
};

type PreviewRequest = {
  action: "preview";
  capabilityId: string;
  payloadPath: string;
  json: boolean;
};

type ExecuteRequest = {
  action: "execute";
  capabilityId: string;
  payloadPath: string;
  confirmation?: string;
  json: boolean;
};

type ActionRequest = PreviewRequest | ExecuteRequest;

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseOptions(
  argv: readonly string[],
  allowedValueFlags: readonly string[],
): ParsedOptions {
  const allowed = new Set(allowedValueFlags);
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--") {
      throw new SaberError("unexpected argument separator", 2);
    }
    if (argument === "--json") {
      if (json) {
        throw new SaberError("duplicate flag --json", 2);
      }
      json = true;
      continue;
    }
    if (argument.startsWith("--")) {
      if (!allowed.has(argument)) {
        throw new SaberError("unknown flag", 2);
      }
      if (values.has(argument)) {
        throw new SaberError(`duplicate flag ${argument}`, 2);
      }
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value === "--" || value.startsWith("-")) {
        throw new SaberError(`${argument} requires a value`, 2);
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new SaberError("unknown flag", 2);
    }
    positionals.push(argument);
  }

  return { positionals, values, json };
}

function singleCapability(options: ParsedOptions, action: string): string {
  if (options.positionals.length !== 1 || options.positionals[0] === undefined) {
    throw new SaberError(`action ${action} requires exactly one capability`, 2);
  }
  return options.positionals[0];
}

function requiredValue(options: ParsedOptions, flag: string): string {
  const value = options.values.get(flag);
  if (value === undefined) {
    throw new SaberError(`${flag} is required`, 2);
  }
  return value;
}

function parseActionRequest(argv: readonly string[]): ActionRequest {
  const [action, ...rest] = argv;
  if (action === undefined) {
    throw new SaberError("action command requires preview or execute", 2);
  }
  if (action === "preview") {
    const options = parseOptions(rest, ["--payload"]);
    return {
      action,
      capabilityId: singleCapability(options, action),
      payloadPath: requiredValue(options, "--payload"),
      json: options.json,
    };
  }
  if (action === "execute") {
    const options = parseOptions(rest, ["--payload", "--confirm"]);
    return {
      action,
      capabilityId: singleCapability(options, action),
      payloadPath: requiredValue(options, "--payload"),
      confirmation: options.values.get("--confirm"),
      json: options.json,
    };
  }
  throw new SaberError("unknown action command", 2);
}

function validateConfig(config: RepositoryConfig): void {
  const errors = validateRepositoryConfig(config);
  if (errors.length > 0) {
    throw new SaberError(`saber.yaml is invalid: ${errors.join("; ")}`, 2);
  }
}

function configuredCapability(config: RepositoryConfig, id: string): Capability {
  const capability = config.capabilities.find((candidate) => candidate.id === id);
  if (capability === undefined) {
    throw new SaberError("unknown capability", 2);
  }
  return capability;
}

function formatPreview(preview: ActionPreview): string {
  const lines = [
    `Action preview for ${preview.capabilityId}:`,
    `- Risk: ${preview.risk}`,
    "- External writes: none",
  ];
  if (preview.operation !== undefined) {
    lines.push(
      `- Credential source: ${preview.operation.account.credentialVariable} (${preview.operation.account.state})`,
      `- Target: ${preview.operation.target.method} ${preview.operation.target.path}`,
      `- Change: ${JSON.stringify(preview.operation.changes)}`,
    );
  }
  lines.push(
    `- Payload digest: ${preview.payloadDigest}`,
    `- Confirmation token: ${preview.token}`,
    "- Recovery: rerun action execute with this exact token and the same payload file.",
    "",
  );
  return lines.join("\n");
}

function formatExecution(execution: ActionExecution): string {
  return [
    `Action executed: ${execution.capabilityId}`,
    `- Risk: ${execution.risk}`,
    `- Connector: ${execution.connector}`,
    `- Request: ${execution.method} ${execution.path}`,
    `- HTTP status: ${execution.status}`,
    `- Data: ${JSON.stringify(execution.data)}`,
    "",
  ].join("\n");
}

function errorResult(error: unknown, json: boolean): ActionCommandResult {
  const message = error instanceof SaberError ? error.message : "action command failed";
  const exitCode = error instanceof SaberError ? error.exitCode : 1;
  if (json) {
    return { exitCode, stdout: asJson({ ok: false, errors: [message] }), stderr: "" };
  }
  return { exitCode, stdout: "", stderr: `${message}\n` };
}

/** Run `saber action preview|execute` with strict parse and risk boundaries. */
export async function runActionCommand(
  argv: readonly string[],
  {
    cwd,
    dependencies = {},
  }: { cwd: string; dependencies?: ActionCommandDependencies },
): Promise<ActionCommandResult> {
  const jsonRequested = argv.includes("--json");
  try {
    const request = parseActionRequest(argv);
    const loadConfig = dependencies.loadConfig ?? loadRepositoryConfig;
    const config = await loadConfig(cwd);
    validateConfig(config);
    const capability = configuredCapability(config, request.capabilityId);
    const payload = await loadActionPayload(cwd, request.payloadPath);
    if (request.action === "preview") {
      const preview = await createActionPreview(cwd, capability, payload, {
        env: dependencies.env,
      });
      return {
        exitCode: 0,
        stdout: request.json ? asJson({ mode: "preview", preview }) : formatPreview(preview),
        stderr: "",
      };
    }
    const execution = await executeAction(cwd, config, capability, payload, {
      confirmation: request.confirmation,
      env: dependencies.env,
      fetch: dependencies.fetch,
    });
    return {
      exitCode: 0,
      stdout: request.json ? asJson({ mode: "executed", action: execution }) : formatExecution(execution),
      stderr: "",
    };
  } catch (error: unknown) {
    return errorResult(error, jsonRequested);
  }
}
