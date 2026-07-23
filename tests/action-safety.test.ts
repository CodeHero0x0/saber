import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createActionPreview, executeAction } from "../src/lib/actions.js";
import type { SafeProcessRunner } from "../src/lib/git.js";
import type { HttpFetch } from "../src/lib/http.js";
import type { Capability } from "../src/lib/models.js";
import { createStandardPreset } from "../src/lib/presets.js";

const environment = {
  JIRA_BASE_URL: "https://jira.example.test",
  JIRA_ACCOUNT_ID: "member@example.test",
  JIRA_API_TOKEN: "never-print-this-token",
};

function successfulJiraFetch(calls: string[]): HttpFetch {
  return async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return {
      ok: true,
      status: init.method === "GET" ? 200 : 204,
      statusText: "OK",
      text: async () => init.method === "GET"
        ? JSON.stringify({ key: "PROJ-123", fields: { summary: "Approved" } })
        : "",
    };
  };
}

test("L2 confirmation is bound to payload and account and consumed exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-action-v4-"));
  const config = createStandardPreset();
  const capability = config.capabilities.find(({ id }) => id === "jira.update")!;
  const payload = { key: "PROJ-123", fields: { summary: "Approved" } };
  const calls: string[] = [];
  try {
    const preview = await createActionPreview(root, capability, payload, { config, env: environment });

    await assert.rejects(
      () => executeAction(root, config, capability, { ...payload, fields: { summary: "Changed" } }, {
        confirmation: preview.token,
        env: environment,
        fetch: successfulJiraFetch(calls),
      }),
      /create a preview/u,
    );
    await assert.rejects(
      () => executeAction(root, config, capability, payload, {
        confirmation: preview.token,
        env: { ...environment, JIRA_ACCOUNT_ID: "other@example.test" },
        fetch: successfulJiraFetch(calls),
      }),
      /create a preview/u,
    );
    assert.deepEqual(calls, []);

    const result = await executeAction(root, config, capability, payload, {
      confirmation: preview.token,
      env: environment,
      fetch: successfulJiraFetch(calls),
    });
    assert.equal(result.state, "executed");
    assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["PUT", "GET"]);

    await assert.rejects(
      () => executeAction(root, config, capability, payload, {
        confirmation: preview.token,
        env: environment,
        fetch: successfulJiraFetch(calls),
      }),
      /create a preview/u,
    );
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L3 is forbidden and previews redact credential-like fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-action-v4-"));
  const config = createStandardPreset();
  const write = config.capabilities.find(({ id }) => id === "jira.update")!;
  const forbidden: Capability = { id: "danger.delete", risk: "L3", kind: "action", connector: "jira" };
  try {
    const preview = await createActionPreview(root, write, {
      key: "PROJ-123",
      fields: { summary: "Visible", apiToken: "payload-secret" },
    }, { config, env: environment });
    const rendered = JSON.stringify(preview);
    assert.match(rendered, /Visible/u);
    assert.doesNotMatch(rendered, /payload-secret|never-print-this-token/u);
    assert.match(rendered, /\[REDACTED\]/u);

    await assert.rejects(() => createActionPreview(root, forbidden, {}), /permanently forbidden/u);
    await assert.rejects(
      () => executeAction(root, config, forbidden, {}, { confirmation: "sha256:invalid" }),
      /permanently forbidden/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git.push preview can target the Saber repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "saber-action-v4-"));
  const config = createStandardPreset();
  const capability = config.capabilities.find(({ id }) => id === "git.push")!;
  const runner: SafeProcessRunner = async ({ args }) => {
    if (args[0] === "check-ref-format") return { exitCode: 0 };
    if (args[0] === "remote") return { exitCode: 0, stdout: "git@github.com:CodeHero0x0/saber.git\n" };
    if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${"a".repeat(40)}\n` };
    return { exitCode: 1 };
  };
  try {
    const preview = await createActionPreview(root, capability, {
      project: ".",
      remote: "origin",
      branch: "main",
    }, {
      config,
      env: { GIT_PUSH_ACCOUNT_ID: "maintainer@example.test" },
      runner,
    });
    assert.equal(preview.risk, "L2");
    assert.deepEqual(preview.operation?.target, {
      connector: "git",
      method: "PUSH",
      path: ".",
      resource: {
        project: ".",
        remote: "origin",
        remoteSource: "ssh://github.com/CodeHero0x0/saber.git",
        branch: "main",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
