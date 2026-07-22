import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import {
  calculatePreviewToken,
  canonicalizeJsonPayload,
  createActionPreview,
  executeAction,
} from "../src/lib/actions.js";
import type { HttpFetch } from "../src/lib/http.js";
import type { McpClientLike } from "../src/lib/mcp/client.js";
import type { Capability, RepositoryConfig } from "../src/lib/models.js";
import type { SafeProcessCommand, SafeProcessRunner } from "../src/lib/git.js";

const jiraEnvironment = {
  JIRA_BASE_URL: "https://jira.example.test",
  JIRA_ACCOUNT_ID: "ba@example.test",
  JIRA_API_TOKEN: "jira-secret-token",
};

const gitlabEnvironment = {
  GITLAB_BASE_URL: "https://gitlab.example.test",
  GITLAB_ACCOUNT_ID: "dev@example.test",
  GITLAB_API_TOKEN: "gitlab-secret-token",
};

function capability(
  id: string,
  risk: Capability["risk"],
  connector?: string,
): Capability {
  return connector === undefined
    ? { id, risk, kind: risk === "L0" ? "read" : "action" }
    : { id, risk, kind: risk === "L0" ? "read" : "action", connector };
}

function configuration(
  capabilities: Capability[],
  connectors: RepositoryConfig["connectors"],
): RepositoryConfig {
  return {
    saber: {
      schemaVersion: 1,
      name: "Saber action tests",
      safety: { externalWrites: "preview-and-confirm", forbiddenRiskLevels: ["L3"] },
    },
    workspace: { schemaVersion: 1, tools: { default: "codex" }, projects: [] },
    capabilities,
    connectors,
    externalAssets: { schemaVersion: 1, assets: [] },
    mcp: { servers: [] },
  };
}

function jiraConfig(risk: Capability["risk"]): RepositoryConfig {
  const id = risk === "L0" ? "jira.read" : "jira.update";
  return configuration([capability(id, risk, "jira")], [
    {
      id: "jira",
      kind: "http",
      requiredEnv: ["JIRA_BASE_URL", "JIRA_ACCOUNT_ID", "JIRA_API_TOKEN"],
      provides: [id],
    },
  ]);
}

function gitlabConfig(risk: Capability["risk"]): RepositoryConfig {
  const id = risk === "L0" ? "gitlab.mr.read" : "gitlab.mr.create";
  return configuration([capability(id, risk, "gitlab")], [
    {
      id: "gitlab",
      kind: "http",
      requiredEnv: ["GITLAB_BASE_URL", "GITLAB_ACCOUNT_ID", "GITLAB_API_TOKEN"],
      provides: [id],
    },
  ]);
}

function gitPushConfig(): RepositoryConfig {
  return configuration(
    [{ id: "git.push", risk: "L2", kind: "action", connector: "git" }],
    [
      {
        id: "git",
        kind: "git-cli",
        requiredEnv: ["GIT_PUSH_ACCOUNT_ID"],
        provides: ["git.push"],
      },
    ],
  );
}

function mcpConfig(options: { read?: boolean; duplicate?: boolean } = {}): RepositoryConfig {
  const capabilities: Capability[] = [
    capability("mysql.write", "L2"),
    ...(options.read === false ? [] : [capability("mysql.read", "L0")]),
  ];
  const tools = [
    { name: "execute", capability: "mysql.write" },
    ...(options.read === false ? [] : [{ name: "query", capability: "mysql.read" }]),
    ...(options.duplicate ? [{ name: "execute-again", capability: "mysql.write" }] : []),
  ];
  return {
    ...configuration(capabilities, []),
    mcp: {
      servers: [
        {
          id: "mysql",
          transport: "stdio",
          command: "node",
          args: ["mock-mysql.js"],
          env: { DATABASE_URL: "PERSONAL_MYSQL_URL" },
          tools,
        },
      ],
    },
  } as RepositoryConfig;
}

function mcpClient(
  tools: string[],
  handler: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown>,
): McpClientLike & { listCalls: number; callNames: string[]; closeCalls: number } {
  const client = {
    listCalls: 0,
    callNames: [] as string[],
    closeCalls: 0,
    async listTools() {
      client.listCalls += 1;
      return { tools: tools.map((name) => ({ name, inputSchema: {} })) };
    },
    async callTool(request: { name: string; arguments?: Record<string, unknown> }) {
      client.callNames.push(request.name);
      return handler(request.name, request.arguments);
    },
    async close() {
      client.closeCalls += 1;
    },
  };
  return client;
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "saber-actions-"));
}

async function writePayload(root: string, name: string, value: unknown): Promise<string> {
  await writeFile(join(root, name), JSON.stringify(value), "utf8");
  return name;
}

type RecordedRequest = { url: string; init: RequestInit };

function recordingFetch(
  calls: RecordedRequest[],
  response: { ok?: boolean; status?: number; statusText?: string; body?: string } = {},
): HttpFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      text: async () => response.body ?? "{}",
    };
  };
}

test("canonical payloads remain stable while every action preview token is unique", async () => {
  const root = await temporaryRoot();
  const action = capability("jira.update", "L2", "jira");
  const firstPayload = { fields: { summary: "Ship safely", labels: ["saber"] }, key: "PROJ-123" };
  const reorderedPayload = { key: "PROJ-123", fields: { labels: ["saber"], summary: "Ship safely" } };

  try {
    assert.equal(canonicalizeJsonPayload(firstPayload), canonicalizeJsonPayload(reorderedPayload));
    assert.equal(
      calculatePreviewToken("jira.update", canonicalizeJsonPayload(firstPayload), "nonce-a"),
      calculatePreviewToken("jira.update", canonicalizeJsonPayload(reorderedPayload), "nonce-a"),
    );
    assert.notEqual(
      calculatePreviewToken("jira.update", canonicalizeJsonPayload(firstPayload), "nonce-a"),
      calculatePreviewToken("jira.update", canonicalizeJsonPayload(firstPayload), "nonce-b"),
    );

    const preview = await createActionPreview(root, action, firstPayload, {
      env: jiraEnvironment,
    });
    const reorderedPreview = await createActionPreview(root, action, reorderedPayload, {
      env: jiraEnvironment,
    });
    assert.notEqual(preview.token, reorderedPreview.token);
    assert.match(preview.token, /^sha256:[a-f0-9]{64}$/u);
    const record = JSON.parse(
      await readFile(
        join(
          root,
          ".saber",
          "runtime",
          "action-previews",
          `${preview.token.replace(/^sha256:/u, "sha256-")}.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.token, preview.token);
    assert.match(String(record.nonce), /^[a-f0-9]{64}$/u);
    assert.equal(record.capabilityId, "jira.update");
    assert.equal(record.payloadDigest, preview.payloadDigest);
    assert.equal(record.state, "ready");
    assert.match(String(record.targetDigest), /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh preview never makes an already consumed confirmation token reusable", async () => {
  const root = await temporaryRoot();
  const config = mcpConfig({ read: false });
  const capability = config.capabilities[0] as Capability;
  const payload = { query: "UPDATE accounts SET active = true" };
  const firstClient = mcpClient(["execute"], async () => ({ accepted: true }));
  const secondClient = mcpClient(["execute"], async () => ({ accepted: true }));
  try {
    const first = await createActionPreview(root, capability, payload, { config });
    await executeAction(root, config, capability, payload, {
      confirmation: first.token,
      connectMcp: async () => firstClient,
    });
    const second = await createActionPreview(root, capability, payload, { config });
    assert.notEqual(second.token, first.token);

    await assert.rejects(
      () => executeAction(root, config, capability, payload, {
        confirmation: first.token,
        connectMcp: async () => secondClient,
      }),
      /preview/u,
    );
    assert.deepEqual(secondClient.callNames, []);

    await executeAction(root, config, capability, payload, {
      confirmation: second.token,
      connectMcp: async () => secondClient,
    });
    assert.deepEqual(secondClient.callNames, ["execute"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L2 execution requires an exact existing preview token before transport", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L2");
  const payloadPath = await writePayload(root, "update.json", {
    key: "PROJ-123",
    fields: { summary: "Do not leak secrets" },
  });
  const calls: RecordedRequest[] = [];

  try {
    const preview = await runCli(
      ["action", "preview", "jira.update", "--payload", payloadPath, "--json"],
      {
        cwd: root,
        dependencies: { actionCommand: { loadConfig: async () => config, env: jiraEnvironment } },
      },
    );
    assert.equal(preview.exitCode, 0);
    const token = (JSON.parse(preview.stdout) as { preview: { token: string } }).preview.token;

    const changedPayloadPath = await writePayload(root, "changed-update.json", {
      key: "PROJ-123",
      fields: { summary: "A different request must need a different preview" },
    });
    const changedPayload = await runCli(
      [
        "action",
        "execute",
        "jira.update",
        "--payload",
        changedPayloadPath,
        "--confirm",
        token,
        "--json",
      ],
      {
        cwd: root,
        dependencies: {
          actionCommand: {
            loadConfig: async () => config,
            env: jiraEnvironment,
            fetch: recordingFetch(calls),
          },
        },
      },
    );
    assert.equal(changedPayload.exitCode, 3);
    assert.match((JSON.parse(changedPayload.stdout) as { errors: string[] }).errors[0] ?? "", /preview/i);
    assert.equal(calls.length, 0);

    for (const confirmation of [undefined, "sha256:wrong"]) {
      const argv = ["action", "execute", "jira.update", "--payload", payloadPath, "--json"];
      if (confirmation !== undefined) {
        argv.push("--confirm", confirmation);
      }
      const result = await runCli(argv, {
        cwd: root,
        dependencies: {
          actionCommand: {
            loadConfig: async () => config,
            env: jiraEnvironment,
            fetch: recordingFetch(calls),
          },
        },
      });
      assert.equal(result.exitCode, 3);
      assert.equal(result.stderr, "");
      assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors[0] ?? "", /preview/i);
      assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors[0] ?? "", /recovery/i);
      assert.equal(calls.length, 0);
    }

    const changedAccount = await runCli(
      [
        "action",
        "execute",
        "jira.update",
        "--payload",
        payloadPath,
        "--confirm",
        token,
        "--json",
      ],
      {
        cwd: root,
        dependencies: {
          actionCommand: {
            loadConfig: async () => config,
            env: { ...jiraEnvironment, JIRA_ACCOUNT_ID: "another@example.test" },
            fetch: recordingFetch(calls),
          },
        },
      },
    );
    assert.equal(changedAccount.exitCode, 3);
    assert.equal(calls.length, 0);

    const acceptedFetch: HttpFetch = async (url, init) => {
      calls.push({ url, init });
      const body = init.method === "GET"
        ? JSON.stringify({ key: "PROJ-123", fields: { summary: "Do not leak secrets" } })
        : "";
      return {
        ok: true,
        status: init.method === "GET" ? 200 : 204,
        statusText: "OK",
        text: async () => body,
      };
    };
    const accepted = await runCli(
      [
        "action",
        "execute",
        "jira.update",
        "--payload",
        payloadPath,
        "--confirm",
        token,
        "--json",
      ],
      {
        cwd: root,
        dependencies: {
          actionCommand: {
            loadConfig: async () => config,
            env: jiraEnvironment,
            fetch: acceptedFetch,
          },
        },
      },
    );
    assert.equal(accepted.exitCode, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://jira.example.test/rest/api/3/issue/PROJ-123");
    assert.equal(calls[0]?.init.method, "PUT");
    assert.equal(calls[0]?.init.headers?.Authorization, "Bearer jira-secret-token");
    assert.equal(calls[0]?.init.body, JSON.stringify({ fields: { summary: "Do not leak secrets" } }));
    assert.equal(calls[1]?.url, "https://jira.example.test/rest/api/3/issue/PROJ-123");
    assert.equal(calls[1]?.init.method, "GET");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L2 preview shows the credential source, target, and exact safe change for human review", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L2");
  const payloadPath = await writePayload(root, "preview-update.json", {
    key: "PROJ-123",
    fields: { summary: "Review this exact change", api_token: "preview-only-secret" },
  });

  try {
    const json = await runCli(
      ["action", "preview", "jira.update", "--payload", payloadPath, "--json"],
      {
        cwd: root,
        dependencies: { actionCommand: { loadConfig: async () => config, env: jiraEnvironment } },
      },
    );
    assert.equal(json.exitCode, 0);
    const preview = (JSON.parse(json.stdout) as {
      preview: {
        operation: {
          account: { credentialVariable: string; identityVariable: string; identity: string; state: string };
          target: { connector: string; method: string; path: string; resource: unknown };
          changes: unknown;
        };
      };
    }).preview;
    assert.deepEqual(preview.operation, {
      account: {
        credentialVariable: "JIRA_API_TOKEN",
        identityVariable: "JIRA_ACCOUNT_ID",
        identity: "ba@example.test",
        state: "declared-local-identity",
      },
      target: {
        connector: "jira",
        method: "PUT",
        path: "/rest/api/3/issue/PROJ-123",
        resource: { type: "jira-issue", key: "PROJ-123" },
      },
      changes: { fields: { summary: "Review this exact change", api_token: "[REDACTED]" } },
    });

    const text = await runCli(
      ["action", "preview", "jira.update", "--payload", payloadPath],
      {
        cwd: root,
        dependencies: { actionCommand: { loadConfig: async () => config, env: jiraEnvironment } },
      },
    );
    assert.equal(text.exitCode, 0);
    assert.match(text.stdout, /JIRA_API_TOKEN/u);
    assert.match(text.stdout, /PUT \/rest\/api\/3\/issue\/PROJ-123/u);
    assert.match(text.stdout, /Review this exact change/u);
    assert.doesNotMatch(json.stdout, /preview-only-secret/u);
    assert.doesNotMatch(text.stdout, /preview-only-secret/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L3 action is refused even when a caller supplies a confirmation", async () => {
  const root = await temporaryRoot();
  const action = capability("danger.delete", "L3", "jira");
  const config = configuration([action], [
    { id: "jira", kind: "http", requiredEnv: [], provides: ["danger.delete"] },
  ]);
  const calls: RecordedRequest[] = [];

  try {
    await assert.rejects(
      () => createActionPreview(root, action, { key: "PROJ-123" }),
      /L3 actions are permanently forbidden/u,
    );
    await assert.rejects(
      () =>
        executeAction(root, config, action, { key: "PROJ-123" }, {
          confirmation: "sha256:anything",
          env: jiraEnvironment,
          fetch: recordingFetch(calls),
        }),
      /L3 actions are permanently forbidden/u,
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured HTTP writes cannot be downgraded below L2", async () => {
  const root = await temporaryRoot();
  const action = capability("jira.update", "L0", "jira");
  const config = configuration([action], [
    {
      id: "jira",
      kind: "http",
      requiredEnv: ["JIRA_BASE_URL", "JIRA_ACCOUNT_ID", "JIRA_API_TOKEN"],
      provides: ["jira.update"],
    },
  ]);
  const calls: RecordedRequest[] = [];

  try {
    await assert.rejects(
      () =>
        executeAction(root, config, action, { key: "PROJ-123", fields: { summary: "unsafe" } }, {
          env: jiraEnvironment,
          fetch: recordingFetch(calls),
        }),
      /must use risk level L2/u,
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Jira read issues a strict GET request with the configured bearer token", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L0");
  const calls: RecordedRequest[] = [];

  try {
    const result = await executeAction(
      root,
      config,
      config.capabilities[0] as Capability,
      { key: "PROJ-123" },
      {
        env: {
          JIRA_BASE_URL: jiraEnvironment.JIRA_BASE_URL,
          JIRA_API_TOKEN: jiraEnvironment.JIRA_API_TOKEN,
        },
        fetch: recordingFetch(calls, {
          body: JSON.stringify({
            key: "PROJ-123",
            fields: { summary: "Return the actual requirement", apiToken: "remote-secret" },
          }),
        }),
      },
    );
    assert.deepEqual(result, {
      state: "executed",
      capabilityId: "jira.read",
      risk: "L0",
      connector: "jira",
      method: "GET",
      path: "/rest/api/3/issue/PROJ-123",
      status: 200,
      data: {
        key: "PROJ-123",
        fields: { summary: "Return the actual requirement", apiToken: "[REDACTED]" },
      },
    });
    assert.equal(calls[0]?.url, "https://jira.example.test/rest/api/3/issue/PROJ-123");
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(calls[0]?.init.headers?.Authorization, "Bearer jira-secret-token");
    assert.equal(calls[0]?.init.body, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("text action output includes the redacted connector response data", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L0");
  const payloadPath = await writePayload(root, "read.json", { key: "PROJ-123" });

  try {
    const result = await runCli(
      ["action", "execute", "jira.read", "--payload", payloadPath],
      {
        cwd: root,
        dependencies: {
          actionCommand: {
            loadConfig: async () => config,
            env: jiraEnvironment,
            fetch: recordingFetch([], {
              body: JSON.stringify({ fields: { summary: "Visible requirement", apiToken: "hidden" } }),
            }),
          },
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Visible requirement/u);
    assert.doesNotMatch(result.stdout, /hidden/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitLab read can recover an existing merge request by source branch", async () => {
  const root = await temporaryRoot();
  const config = gitlabConfig("L0");
  const calls: RecordedRequest[] = [];

  try {
    const result = await executeAction(
      root,
      config,
      config.capabilities[0] as Capability,
      { project: "team/service", sourceBranch: "feature/saber", targetBranch: "main" },
      {
        env: gitlabEnvironment,
        fetch: recordingFetch(calls, {
          body: JSON.stringify([{ iid: 7, state: "opened", source_branch: "feature/saber" }]),
        }),
      },
    );

    assert.equal(
      calls[0]?.url,
      "https://gitlab.example.test/api/v4/projects/team%2Fservice/merge_requests?state=opened&source_branch=feature%2Fsaber&target_branch=main",
    );
    assert.deepEqual(result.data, [
      { iid: 7, state: "opened", source_branch: "feature/saber" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate GitLab MR creation returns a branch-query recovery path", async () => {
  const root = await temporaryRoot();
  const config = gitlabConfig("L2");
  const payload = {
    project: "team/service",
    title: "Create Saber workflow",
    sourceBranch: "feature/saber",
    targetBranch: "main",
  };
  const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
    env: gitlabEnvironment,
  });

  try {
    await assert.rejects(
      () =>
        executeAction(root, config, config.capabilities[0] as Capability, payload, {
          confirmation: preview.token,
          env: gitlabEnvironment,
          fetch: recordingFetch([], { ok: false, status: 409, statusText: "Conflict" }),
        }),
      /gitlab\.mr\.read.*sourceBranch/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git.push binds project, account, branch, commit, and reconciles the remote ref", async () => {
  const root = await temporaryRoot();
  const config = gitPushConfig();
  config.workspace.projects = [{ name: "backend", path: "projects/backend" }];
  await mkdir(join(root, "projects/backend/.git"), { recursive: true });
  const payload = { project: "backend", remote: "origin", branch: "feature/saber" };
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const calls: SafeProcessCommand[] = [];
  const runner: SafeProcessRunner = async (command) => {
    calls.push(command);
    if (command.args.includes("check-ref-format")) {
      return { exitCode: 0 };
    }
    if (command.args.includes("get-url")) {
      return { exitCode: 0, stdout: "https://gitlab.example.test/team/backend.git\n" };
    }
    if (command.args.includes("rev-parse")) {
      return { exitCode: 0, stdout: `${commit}\n` };
    }
    if (command.args.includes("push")) {
      return { exitCode: 0 };
    }
    if (command.args.includes("ls-remote")) {
      return { exitCode: 0, stdout: `${commit}\trefs/heads/feature/saber\n` };
    }
    return { exitCode: 1 };
  };
  const environment = { GIT_PUSH_ACCOUNT_ID: "dev@example.test" };

  try {
    const preview = await createActionPreview(
      root,
      config.capabilities[0] as Capability,
      payload,
      { env: environment, config, runner },
    );
    assert.deepEqual(preview.operation, {
      account: {
        credentialVariable: "local-git-credential-helper",
        identityVariable: "GIT_PUSH_ACCOUNT_ID",
        identity: "dev@example.test",
        state: "declared-local-identity",
      },
      target: {
        connector: "git",
        method: "PUSH",
        path: "projects/backend",
        resource: {
          project: "backend",
          remote: "origin",
          remoteSource: "https://gitlab.example.test/team/backend.git",
          branch: "feature/saber",
        },
      },
      changes: { commit },
    });
    assert.equal(calls.some((call) => call.args.includes("push")), false);

    const result = await executeAction(
      root,
      config,
      config.capabilities[0] as Capability,
      payload,
      { confirmation: preview.token, env: environment, runner },
    );
    assert.equal(result.connector, "git");
    assert.equal(result.method, "PUSH");
    assert.deepEqual(result.data, {
      project: "backend",
      remote: "origin",
      branch: "feature/saber",
      commit,
      reconciled: true,
    });
    const push = calls.find((call) => call.args.includes("push"));
    assert.ok(push);
    assert.equal(push.args.some((argument) => argument.includes("force")), false);
    assert.ok(push.args.includes("--no-follow-tags"));
    assert.ok(push.args.includes("https://gitlab.example.test/team/backend.git"));
    assert.equal(push.args.includes("origin"), false);
    assert.ok(push.args.includes(`${commit}:refs/heads/feature/saber`));
    const remoteLookup = calls.find((call) => call.args.includes("get-url"));
    assert.ok(remoteLookup?.args.includes("--push"));
    assert.ok(remoteLookup?.args.includes("--all"));
    const reconcile = calls.find((call) => call.args.includes("ls-remote"));
    assert.ok(reconcile?.args.includes("https://gitlab.example.test/team/backend.git"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git.push rejects multiple push URLs before writing", async () => {
  const root = await temporaryRoot();
  const config = gitPushConfig();
  config.workspace.projects = [{ name: "backend", path: "projects/backend" }];
  await mkdir(join(root, "projects/backend/.git"), { recursive: true });
  let pushed = false;
  const runner: SafeProcessRunner = async (command) => {
    if (command.args.includes("check-ref-format")) return { exitCode: 0 };
    if (command.args.includes("get-url")) {
      return {
        exitCode: 0,
        stdout: "https://gitlab.example.test/team/backend.git\nhttps://mirror.example.test/team/backend.git\n",
      };
    }
    if (command.args.includes("push")) pushed = true;
    return { exitCode: 1 };
  };

  try {
    await assert.rejects(
      () => createActionPreview(
        root,
        config.capabilities[0] as Capability,
        { project: "backend", remote: "origin", branch: "feature/saber" },
        { env: { GIT_PUSH_ACCOUNT_ID: "dev@example.test" }, config, runner },
      ),
      /exactly one push URL/iu,
    );
    assert.equal(pushed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git.push reconciles after an uncertain push failure before allowing recovery", async () => {
  const root = await temporaryRoot();
  const config = gitPushConfig();
  config.workspace.projects = [{ name: "backend", path: "projects/backend" }];
  await mkdir(join(root, "projects/backend/.git"), { recursive: true });
  const payload = { project: "backend", remote: "origin", branch: "feature/uncertain" };
  const commit = "fedcba9876543210fedcba9876543210fedcba98";
  let pushAttempted = false;
  const calls: SafeProcessCommand[] = [];
  const runner: SafeProcessRunner = async (command) => {
    calls.push(command);
    if (command.args.includes("check-ref-format")) return { exitCode: 0 };
    if (command.args.includes("get-url")) {
      return { exitCode: 0, stdout: "git@gitlab.example.test:team/backend.git\n" };
    }
    if (command.args.includes("rev-parse")) return { exitCode: 0, stdout: `${commit}\n` };
    if (command.args.includes("push")) {
      pushAttempted = true;
      return { exitCode: 1 };
    }
    if (command.args.includes("ls-remote")) {
      return { exitCode: 0, stdout: `${commit}\trefs/heads/feature/uncertain\n` };
    }
    return { exitCode: 1 };
  };
  const environment = { GIT_PUSH_ACCOUNT_ID: "dev@example.test" };

  try {
    const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
      env: environment,
      config,
      runner,
    });
    const result = await executeAction(root, config, config.capabilities[0] as Capability, payload, {
      confirmation: preview.token,
      env: environment,
      runner,
    });
    assert.equal(pushAttempted, true);
    assert.equal(result.data && "reconciled" in result.data ? result.data.reconciled : false, true);
    assert.ok(calls.some((call) => call.args.includes("ls-remote")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitLab read and create map only approved payload fields to their API request shapes", async () => {
  const root = await temporaryRoot();
  const readConfig = gitlabConfig("L0");
  const createConfig = gitlabConfig("L2");
  const calls: RecordedRequest[] = [];

  try {
    const read = await executeAction(
      root,
      readConfig,
      readConfig.capabilities[0] as Capability,
      { project: 42, iid: 7 },
      { env: gitlabEnvironment, fetch: recordingFetch(calls) },
    );
    assert.equal(read.method, "GET");
    assert.equal(calls[0]?.url, "https://gitlab.example.test/api/v4/projects/42/merge_requests/7");
    assert.equal(calls[0]?.init.method, "GET");

    const payload = {
      project: "team/service",
      title: "Create Saber workflow",
      sourceBranch: "feature/saber",
      targetBranch: "main",
      description: "Review the safe preview gate.",
      removeSourceBranch: true,
    };
    const preview = await createActionPreview(root, createConfig.capabilities[0] as Capability, payload, {
      env: gitlabEnvironment,
    });
    const create = await executeAction(
      root,
      createConfig,
      createConfig.capabilities[0] as Capability,
      payload,
      {
        confirmation: preview.token,
        env: gitlabEnvironment,
        fetch: async (url, init) => {
          calls.push({ url, init });
          const body = init.method === "POST"
            ? JSON.stringify({ iid: 7, state: "opened" })
            : JSON.stringify({
                iid: 7,
                state: "opened",
                title: "Create Saber workflow",
                source_branch: "feature/saber",
                target_branch: "main",
              });
          return { ok: true, status: init.method === "POST" ? 201 : 200, statusText: "OK", text: async () => body };
        },
      },
    );
    assert.equal(create.method, "POST");
    assert.equal(calls[1]?.url, "https://gitlab.example.test/api/v4/projects/team%2Fservice/merge_requests");
    assert.equal(calls[1]?.init.method, "POST");
    assert.equal(
      calls[1]?.init.body,
      JSON.stringify({
        title: "Create Saber workflow",
        source_branch: "feature/saber",
        target_branch: "main",
        description: "Review the safe preview gate.",
        remove_source_branch: true,
      }),
    );
    assert.equal(
      calls[2]?.url,
      "https://gitlab.example.test/api/v4/projects/team%2Fservice/merge_requests/7",
    );
    assert.equal(calls[2]?.init.method, "GET");
    assert.deepEqual(create.data, {
      iid: 7,
      state: "opened",
      title: "Create Saber workflow",
      source_branch: "feature/saber",
      target_branch: "main",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful write with failed reconciliation pauses without inviting a duplicate write", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L2");
  const payload = { key: "PROJ-123", fields: { summary: "Reconcile me" } };
  const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
    env: jiraEnvironment,
  });
  let requestCount = 0;
  const fetch: HttpFetch = async () => {
    requestCount += 1;
    return requestCount === 1
      ? { ok: true, status: 204, statusText: "No Content", text: async () => "" }
      : { ok: false, status: 503, statusText: "Unavailable", text: async () => "" };
  };

  try {
    await assert.rejects(
      () =>
        executeAction(root, config, config.capabilities[0] as Capability, payload, {
          confirmation: preview.token,
          env: jiraEnvironment,
          fetch,
        }),
      /may have succeeded.*do not repeat.*jira\.read/iu,
    );
    assert.equal(requestCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write reconciliation verifies intended state and recovers an uncertain transport result", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L2");
  const payload = { key: "PROJ-123", fields: { summary: "Confirmed remotely" } };

  try {
    const mismatchPreview = await createActionPreview(
      root,
      config.capabilities[0] as Capability,
      payload,
      { env: jiraEnvironment },
    );
    await assert.rejects(
      () => executeAction(root, config, config.capabilities[0] as Capability, payload, {
        confirmation: mismatchPreview.token,
        env: jiraEnvironment,
        fetch: recordingFetch([], {
          body: JSON.stringify({ fields: { summary: "Different value" } }),
        }),
      }),
      /may have succeeded.*do not repeat.*jira\.read/iu,
    );

    const uncertainPreview = await createActionPreview(
      root,
      config.capabilities[0] as Capability,
      payload,
      { env: jiraEnvironment },
    );
    let callCount = 0;
    const recovered = await executeAction(
      root,
      config,
      config.capabilities[0] as Capability,
      payload,
      {
        confirmation: uncertainPreview.token,
        env: jiraEnvironment,
        fetch: async (_url, init) => {
          callCount += 1;
          if (callCount === 1) throw new Error("uncertain write transport");
          assert.equal(init.method, "GET");
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => JSON.stringify({ fields: { summary: "Confirmed remotely" } }),
          };
        },
      },
    );
    assert.equal(callCount, 2);
    assert.equal(recovered.status, 0);
    assert.deepEqual(recovered.data, { fields: { summary: "Confirmed remotely" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitLab reconciliation rejects an empty branch query after an unparseable write response", async () => {
  const root = await temporaryRoot();
  const config = gitlabConfig("L2");
  const payload = {
    project: "team/service",
    title: "Create Saber workflow",
    sourceBranch: "feature/saber",
    targetBranch: "main",
  };
  const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
    env: gitlabEnvironment,
  });
  let callCount = 0;

  try {
    await assert.rejects(
      () => executeAction(root, config, config.capabilities[0] as Capability, payload, {
        confirmation: preview.token,
        env: gitlabEnvironment,
        fetch: async (_url, init) => {
          callCount += 1;
          return {
            ok: true,
            status: init.method === "POST" ? 201 : 200,
            statusText: "OK",
            text: async () => (init.method === "POST" ? "not-json" : "[]"),
          };
        },
      }),
      /may have succeeded.*do not repeat.*gitlab\.mr\.read/iu,
    );
    assert.equal(callCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connector failures redact API tokens, base URL query data, and payload text", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L0");
  const calls: RecordedRequest[] = [];

  try {
    await assert.rejects(
      () =>
        executeAction(
          root,
          config,
          config.capabilities[0] as Capability,
          { key: "PROJ-123" },
          {
            env: jiraEnvironment,
            fetch: recordingFetch(calls, {
              ok: false,
              status: 401,
              statusText: "jira-secret-token ?query=private Do not leak secrets",
            }),
          },
        ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        return (
          /Jira request failed with HTTP 401/u.test(message) &&
          !message.includes("jira-secret-token") &&
          !message.includes("?query=private") &&
          !message.includes("Do not leak secrets")
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing connector environment and missing MCP mappings stop safely", async () => {
  const root = await temporaryRoot();
  const jira = jiraConfig("L0");
  const mysql = configuration([capability("mysql.read", "L0")], []);

  try {
    await assert.rejects(
      () =>
        executeAction(root, jira, jira.capabilities[0] as Capability, { key: "PROJ-123" }, {
          env: { JIRA_BASE_URL: "https://jira.example.test", JIRA_ACCOUNT_ID: "ba@example.test" },
        }),
      /JIRA_API_TOKEN/u,
    );
    await assert.rejects(
      () =>
        executeAction(root, mysql, mysql.capabilities[0] as Capability, { query: "select 1" }, {}),
      /native MCP tool/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("action rejects escaping or symbolic-link payloads and keeps JSON errors parseable", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  const config = jiraConfig("L0");
  await writeFile(join(outside, "private.json"), JSON.stringify({ key: "PROJ-123" }), "utf8");
  await symlink(join(outside, "private.json"), join(root, "payload.json"));

  try {
    const escaped = await runCli(
      ["action", "preview", "jira.read", "--payload", "../private.json", "--json"],
      { cwd: root, dependencies: { actionCommand: { loadConfig: async () => config } } },
    );
    assert.equal(escaped.exitCode, 2);
    assert.equal(escaped.stderr, "");
    assert.match((JSON.parse(escaped.stdout) as { errors: string[] }).errors[0] ?? "", /payload file/u);
    assert.doesNotMatch(escaped.stdout, /private\.json/u);

    const linked = await runCli(
      ["action", "preview", "jira.read", "--payload", "payload.json", "--json"],
      { cwd: root, dependencies: { actionCommand: { loadConfig: async () => config } } },
    );
    assert.equal(linked.exitCode, 2);
    assert.match((JSON.parse(linked.stdout) as { errors: string[] }).errors[0] ?? "", /payload file/u);

    const malformed = await runCli(
      ["action", "preview", "jira.read", "--payload", "payload.json", "--json", "--unknown"],
      { cwd: root, dependencies: { actionCommand: { loadConfig: async () => config } } },
    );
    assert.equal(malformed.exitCode, 2);
    assert.equal(malformed.stderr, "");
    assert.match((JSON.parse(malformed.stdout) as { errors: string[] }).errors[0] ?? "", /unknown flag/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("action parser rejects malformed flags while preview reads only the non-secret connector target", async () => {
  const root = await temporaryRoot();
  const config = jiraConfig("L0");
  const payloadPath = await writePayload(root, "payload.json", { key: "PROJ-123" });
  const previewEnvironment = new Proxy<Record<string, string | undefined>>(
    { JIRA_BASE_URL: jiraEnvironment.JIRA_BASE_URL, JIRA_ACCOUNT_ID: jiraEnvironment.JIRA_ACCOUNT_ID },
    {
      get: (target, property) => {
        if (property === "JIRA_API_TOKEN") {
          throw new Error("preview read connector API token");
        }
        return typeof property === "string" ? target[property] : undefined;
      },
    },
  );

  try {
    const preview = await runCli(
      ["action", "preview", "jira.read", "--payload", payloadPath, "--json"],
      {
        cwd: root,
        dependencies: {
          actionCommand: {
            loadConfig: async () => config,
            env: previewEnvironment,
          },
        },
      },
    );
    assert.equal(preview.exitCode, 0);

    for (const argv of [
      ["action", "preview", "jira.read", "--payload", payloadPath, "--payload", payloadPath, "--json"],
      ["action", "preview", "jira.read", "--payload", "--json"],
      ["action", "preview", "jira.read", "--payload", payloadPath, "--confirm", "nope", "--json"],
      ["action", "execute", "jira.read", "--payload", payloadPath, "--json", "--json"],
    ]) {
      const result = await runCli(argv, {
        cwd: root,
        dependencies: { actionCommand: { loadConfig: async () => config } },
      });
      assert.equal(result.exitCode, 2);
      assert.equal(result.stderr, "");
      assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors[0] ?? "", /(duplicate|requires|unknown flag)/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP L2 preview resolves one tool, redacts arguments, and binds server plus config", async () => {
  const root = await temporaryRoot();
  const config = mcpConfig();
  const payload = {
    query: "UPDATE accounts SET password = 'mcp-secret'",
    password: "mcp-secret",
  };
  try {
    const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
      config,
    });
    assert.equal(preview.risk, "L2");
    assert.equal(preview.operation?.target.connector, "mcp");
    assert.equal(preview.operation?.target.path, "mysql/execute");
    assert.equal(preview.operation?.account.credentialVariable, "configured MCP environment references");
    assert.doesNotMatch(JSON.stringify(preview.operation), /mcp-secret/u);

    const reordered = await createActionPreview(
      root,
      config.capabilities[0] as Capability,
      { password: "mcp-secret", query: "UPDATE accounts SET password = 'mcp-secret'" },
      { config },
    );
    assert.notEqual(reordered.token, preview.token);

    const drifted = structuredClone(config);
    drifted.mcp.servers[0] = {
      ...drifted.mcp.servers[0]!,
      transport: "stdio",
      command: "other-node",
    };
    const changed = await createActionPreview(root, drifted.capabilities[0] as Capability, payload, {
      config: drifted,
    });
    assert.notEqual(changed.token, preview.token);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP L2 preview redacts embedded credential assignments in JSON and text output", async () => {
  const root = await temporaryRoot();
  const config = mcpConfig();
  const payloadPath = await writePayload(root, "embedded-mcp-secrets.json", {
    query: "UPDATE accounts SET password='leaked-password', display_name='Visible Name'",
    text: "token=leaked-token Authorization: Bearer leaked-bearer keep=this-visible",
    url: "https://example.test/run?api-key=leaked-api-key&page=2&secret=leaked-secret",
    metadata: "client_secret=leaked-client-secret Authorization=Basic leaked-basic trace=visible",
  });

  try {
    for (const json of [true, false]) {
      const result = await runCli(
        [
          "action",
          "preview",
          "mysql.write",
          "--payload",
          payloadPath,
          ...(json ? ["--json"] : []),
        ],
        {
          cwd: root,
          dependencies: { actionCommand: { loadConfig: async () => config } },
        },
      );
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      assert.doesNotMatch(
        result.stdout,
        /leaked-(?:password|token|bearer|api-key|secret|client-secret|basic)/u,
      );
      assert.match(result.stdout, /Visible Name/u);
      assert.match(result.stdout, /keep=this-visible/u);
      assert.match(result.stdout, /page=2/u);
      assert.match(result.stdout, /trace=visible/u);
      assert.match(result.stdout, /\[REDACTED\]/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP L2 execution calls the write once but stays uncertain without an explicit reconciliation matcher", async () => {
  const root = await temporaryRoot();
  const config = mcpConfig();
  const payload = { query: "UPDATE accounts SET active = true" };
  const client = mcpClient(["execute", "query"], async (name) =>
    name === "execute" ? { accepted: true } : { rows: [{ active: true }] },
  );
  let connections = 0;
  try {
    const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
      config,
    });
    const result = await executeAction(root, config, config.capabilities[0] as Capability, payload, {
      confirmation: preview.token,
      connectMcp: async () => {
        connections += 1;
        return client;
      },
    });
    assert.equal(result.state, "uncertain");
    assert.equal(result.connector, "mcp");
    assert.equal(result.method, "CALL");
    assert.equal(result.path, "mysql/execute");
    assert.deepEqual(client.callNames, ["execute", "query"]);
    assert.equal(client.listCalls, 1);
    assert.equal(client.closeCalls, 1);
    assert.equal(connections, 1);
    assert.equal(result.reconciliation?.state, "observed");
    assert.equal(result.reconciliation?.tool, "query");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP L2 execution redacts client environment secrets from write and reconciliation results", async () => {
  const root = await temporaryRoot();
  const config = mcpConfig();
  const payload = { query: "UPDATE accounts SET active = true" };
  const environmentSecret = "upstream-environment-secret";
  const client = mcpClient(["execute", "query"], async (name) =>
    name === "execute"
      ? { message: `write accepted with ${environmentSecret}`, status: "accepted" }
      : { message: `read used ${environmentSecret}`, rows: [{ active: true }] },
  );
  Object.defineProperty(client, "secrets", {
    value: Object.freeze([environmentSecret]),
    enumerable: false,
  });

  try {
    const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
      config,
    });
    const result = await executeAction(root, config, config.capabilities[0] as Capability, payload, {
      confirmation: preview.token,
      connectMcp: async () => client,
    });
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, new RegExp(environmentSecret, "u"));
    assert.match(serialized, /write accepted with \[REDACTED\]/u);
    assert.match(serialized, /read used \[REDACTED\]/u);
    assert.deepEqual(client.callNames, ["execute", "query"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP L2 execution returns explicit uncertain without a read capability and never retries the write", async () => {
  const root = await temporaryRoot();
  const config = mcpConfig({ read: false });
  const payload = { query: "UPDATE accounts SET active = true" };
  const client = mcpClient(["execute"], async () => ({ accepted: true }));
  try {
    const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, {
      config,
    });
    const result = await executeAction(root, config, config.capabilities[0] as Capability, payload, {
      confirmation: preview.token,
      connectMcp: async () => client,
    });
    assert.equal(result.state, "uncertain");
    assert.equal(result.reconciliation?.state, "unavailable");
    assert.deepEqual(client.callNames, ["execute"]);
    assert.equal(client.closeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP L2 action stops on duplicate mapping, upstream drift, missing tools, and non-L2 risks", async () => {
  const root = await temporaryRoot();
  const payload = { query: "UPDATE accounts SET active = true" };
  try {
    const duplicate = mcpConfig({ duplicate: true });
    await assert.rejects(
      () => createActionPreview(root, duplicate.capabilities[0] as Capability, payload, { config: duplicate }),
      /exactly one MCP server\/tool mapping/u,
    );

    const config = mcpConfig();
    const preview = await createActionPreview(root, config.capabilities[0] as Capability, payload, { config });
    const drifted = structuredClone(config);
    drifted.mcp.servers[0] = { ...drifted.mcp.servers[0]!, transport: "stdio", command: "changed-node" };
    let connected = false;
    await assert.rejects(
      () => executeAction(root, drifted, drifted.capabilities[0] as Capability, payload, {
        confirmation: preview.token,
        connectMcp: async () => {
          connected = true;
          return mcpClient(["execute", "query"], async () => ({}));
        },
      }),
      /preview/u,
    );
    assert.equal(connected, false);

    const missingToolClient = mcpClient(["query"], async () => ({}));
    const freshPreview = await createActionPreview(root, config.capabilities[0] as Capability, payload, { config });
    await assert.rejects(
      () => executeAction(root, config, config.capabilities[0] as Capability, payload, {
        confirmation: freshPreview.token,
        connectMcp: async () => missingToolClient,
      }),
      /upstream MCP tool/u,
    );
    assert.deepEqual(missingToolClient.callNames, []);

    const read = capability("mysql.read", "L0");
    await assert.rejects(
      () => createActionPreview(root, read, { query: "SELECT 1" }, { config: { ...config, capabilities: [read] } }),
      /native L0\/L1 MCP tool/u,
    );
    await assert.rejects(
      () => createActionPreview(root, { id: "mysql.write", risk: "L3", kind: "action" }, payload, { config }),
      /L3/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
