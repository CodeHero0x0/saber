import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import type { Capability, RepositoryConfig } from "../src/lib/models.js";

const jiraEnvironment = {
  JIRA_BASE_URL: "https://jira.example.test",
  JIRA_API_TOKEN: "jira-secret-token",
};

const gitlabEnvironment = {
  GITLAB_BASE_URL: "https://gitlab.example.test",
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
  };
}

function jiraConfig(risk: Capability["risk"]): RepositoryConfig {
  const id = risk === "L0" ? "jira.read" : "jira.update";
  return configuration([capability(id, risk, "jira")], [
    {
      id: "jira",
      kind: "http",
      requiredEnv: ["JIRA_BASE_URL", "JIRA_API_TOKEN"],
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
      requiredEnv: ["GITLAB_BASE_URL", "GITLAB_API_TOKEN"],
      provides: [id],
    },
  ]);
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

test("canonical action preview tokens are deterministic across JSON key order", async () => {
  const root = await temporaryRoot();
  const action = capability("jira.update", "L2", "jira");
  const firstPayload = { fields: { summary: "Ship safely", labels: ["saber"] }, key: "PROJ-123" };
  const reorderedPayload = { key: "PROJ-123", fields: { labels: ["saber"], summary: "Ship safely" } };

  try {
    assert.equal(canonicalizeJsonPayload(firstPayload), canonicalizeJsonPayload(reorderedPayload));
    assert.equal(
      calculatePreviewToken("jira.update", canonicalizeJsonPayload(firstPayload)),
      calculatePreviewToken("jira.update", canonicalizeJsonPayload(reorderedPayload)),
    );

    const preview = await createActionPreview(root, action, firstPayload, {
      env: jiraEnvironment,
    });
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
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.token, preview.token);
    assert.equal(record.capabilityId, "jira.update");
    assert.equal(record.payloadDigest, preview.payloadDigest);
    assert.equal(record.state, "ready");
    assert.match(String(record.targetDigest), /^sha256:[a-f0-9]{64}$/u);
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
            fetch: recordingFetch(calls),
          },
        },
      },
    );
    assert.equal(accepted.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://jira.example.test/rest/api/3/issue/PROJ-123");
    assert.equal(calls[0]?.init.method, "PUT");
    assert.equal(calls[0]?.init.headers?.Authorization, "Bearer jira-secret-token");
    assert.equal(calls[0]?.init.body, JSON.stringify({ fields: { summary: "Do not leak secrets" } }));
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
          account: { credentialVariable: string; state: string };
          target: { connector: string; method: string; path: string; resource: unknown };
          changes: unknown;
        };
      };
    }).preview;
    assert.deepEqual(preview.operation, {
      account: {
        credentialVariable: "JIRA_API_TOKEN",
        state: "identity-resolved-at-execution",
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
      requiredEnv: ["JIRA_BASE_URL", "JIRA_API_TOKEN"],
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
        env: jiraEnvironment,
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
      { confirmation: preview.token, env: gitlabEnvironment, fetch: recordingFetch(calls) },
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

test("missing connector environment pauses safely and unsupported MCP actions do not pretend to execute", async () => {
  const root = await temporaryRoot();
  const jira = jiraConfig("L0");
  const mysql = configuration([capability("mysql.read", "L0", "mysql-mcp")], [
    {
      id: "mysql-mcp",
      kind: "mcp-command",
      requiredEnv: ["MYSQL_MCP_COMMAND"],
      provides: ["mysql.read"],
    },
  ]);

  try {
    await assert.rejects(
      () =>
        executeAction(root, jira, jira.capabilities[0] as Capability, { key: "PROJ-123" }, {
          env: { JIRA_BASE_URL: "https://jira.example.test" },
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
    { JIRA_BASE_URL: jiraEnvironment.JIRA_BASE_URL },
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
