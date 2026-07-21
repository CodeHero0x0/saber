# Saber Core Workspace CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first independently usable Saber milestone: a Node CLI that validates team assets, checks the local development environment, and reports the state of configured independent project repositories.

**Architecture:** Use a dependency-light Node 20+ ESM CLI. A single YAML loader reads repository-owned configuration; pure validation and status functions accept injected dependencies so that Node's built-in test runner can test them without Jira, GitLab, MCP, or live project repositories. The CLI exposes only read-only commands in this milestone: `validate`, `doctor`, and `status`.

**Tech Stack:** Node.js 20+, strict TypeScript with NodeNext modules, `yaml`, `tsx`, Node `node:test` and `node:assert/strict`, Git CLI.

**Scope boundary:** This plan deliberately does not create Jira/GitLab write integrations, clone business repositories, generate Codex/Claude runtime assets, or execute L2 actions. Those are separate plans after the core contract is verified.

---

## TypeScript execution amendment (2026-07-22)

The user requires TypeScript wherever practical. This amendment overrides the JavaScript-oriented file names and commands in the task details below:

- Every source path under `src/` uses `.ts`; every test path uses `.test.ts`.
- Source imports use NodeNext-compatible `.js` specifiers and resolve to TypeScript source during `tsx` test execution.
- `package.json` declares `typescript`, `tsx` and `@types/node` as development dependencies, with `build`, `check`, `test` and `saber` scripts.
- `tsconfig.json` uses `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `rootDir: "src"` and `outDir: "dist"`.
- `tsx --test tests/*.test.ts` replaces direct `node --test` invocations; `tsc --noEmit` is required before each task commit.
- The package bin points to `dist/cli.js`; `npm run build` creates the generated JavaScript artifact, which remains ignored by Git.

No implementation may remain in `src/**/*.js` once Task 1 is complete.

---

## File structure

| Path | Responsibility |
|---|---|
| `package.json` | Node engine, CLI entry point, scripts and YAML dependency |
| `src/cli.js` | Executable command dispatcher and public `runCli` entry point |
| `src/lib/errors.js` | Typed `SaberError` with stable exit code and message |
| `src/lib/files.js` | Read-only file and directory helpers |
| `src/lib/config.js` | YAML loading and normalization for Saber, workspace and capability files |
| `src/lib/validation.js` | Pure configuration validation functions |
| `src/lib/git.js` | Narrow injected wrapper around `git -C <path> status --porcelain=v1 --branch` |
| `src/commands/validate.js` | Validates configuration and renders text/JSON results |
| `src/commands/doctor.js` | Reports Node, Git, asset and workspace health |
| `src/commands/status.js` | Reports whether each configured business repository is present and clean |
| `saber.yaml` | Initial security/default policy |
| `workspace.yaml` | Empty but valid team project catalog |
| `mcp/capabilities.yaml` | Semantic capability catalog with L0-L2 entries only |
| `roles/*.md`, `workflows/*/*.md`, `skills/*.md` | Minimal neutral asset examples referenced by the design |
| `tests/**/*.test.js` | Unit and CLI behavior tests |
| `.github/workflows/ci.yml` | Run dependency install and tests on pushes and pull requests |
| `README.md` | Local setup and safe command examples |

## Task 1: Establish the Node CLI contract

**Files:**
- Create: `package.json`
- Create: `src/cli.js`
- Create: `src/lib/errors.js`
- Create: `tests/cli.test.js`

- [ ] **Step 1: Write failing CLI tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("runCli prints command help when no command is supplied", async () => {
  const result = await runCli([], { cwd: process.cwd() });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /saber validate/);
  assert.equal(result.stderr, "");
});

test("runCli rejects an unknown command", async () => {
  const result = await runCli(["unknown"], { cwd: process.cwd() });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown command: unknown/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli.test.js`
Expected: FAIL because `src/cli.js` does not exist.

- [ ] **Step 3: Create the package manifest and minimal implementation**

```json
{
  "name": "@codehero0x0/saber",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "saber": "./src/cli.js" },
  "scripts": {
    "test": "node --test",
    "check": "node --check src/cli.js && node --check src/lib/errors.js"
  },
  "dependencies": { "yaml": "^2.5.1" }
}
```

```js
// src/lib/errors.js
export class SaberError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
    this.name = "SaberError";
  }
}
```

```js
// src/cli.js
import { fileURLToPath } from "node:url";
import { SaberError } from "./lib/errors.js";

const help = "Usage: saber <validate|doctor|status> [--json]\\n";

export async function runCli(argv, { cwd = process.cwd() } = {}) {
  const [command] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: help, stderr: "" };
  }
  if (!["validate", "doctor", "status"].includes(command)) {
    return {
      exitCode: new SaberError(`Unknown command: ${command}`, 2).exitCode,
      stdout: "",
      stderr: `Unknown command: ${command}\\n`
    };
  }
  return { exitCode: 0, stdout: `${command} is not implemented yet\\n`, stderr: "" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
```

- [ ] **Step 4: Install the declared dependency and run the tests**

Run: `npm install`
Run: `npm test`
Expected: both commands exit 0; the two CLI tests pass.

- [ ] **Step 5: Commit the contract**

```bash
git add package.json package-lock.json src/cli.js src/lib/errors.js tests/cli.test.js
git commit -m "feat: add saber CLI command contract"
```

## Task 2: Load and validate repository-owned YAML

**Files:**
- Create: `src/lib/files.js`
- Create: `src/lib/config.js`
- Create: `src/lib/validation.js`
- Create: `tests/validation.test.js`

- [ ] **Step 1: Write failing validation tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { validateCapabilityCatalog, validateWorkspace } from "../src/lib/validation.js";

test("validateWorkspace rejects duplicated project names", () => {
  const errors = validateWorkspace({
    schemaVersion: 1,
    projects: [
      { name: "frontend", path: "projects/frontend" },
      { name: "frontend", path: "projects/backend" }
    ]
  });

  assert.deepEqual(errors, ["workspace.projects contains duplicate name: frontend"]);
});

test("validateCapabilityCatalog rejects L3 capabilities", () => {
  const errors = validateCapabilityCatalog({
    schemaVersion: 1,
    capabilities: [{ id: "git.force-push", risk: "L3" }]
  });

  assert.deepEqual(errors, ["capability git.force-push uses forbidden risk level L3"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/validation.test.js`
Expected: FAIL because `src/lib/validation.js` does not exist.

- [ ] **Step 3: Implement pure validation and YAML loading**

```js
// src/lib/validation.js
const riskLevels = new Set(["L0", "L1", "L2", "L3"]);

export function validateWorkspace(workspace) {
  const errors = [];
  const names = new Set();
  for (const project of workspace?.projects ?? []) {
    if (!project?.name) errors.push("workspace.projects entry is missing name");
    if (names.has(project?.name)) errors.push(`workspace.projects contains duplicate name: ${project.name}`);
    names.add(project?.name);
    if (!project?.path || project.path.startsWith("/") || project.path.includes("..")) {
      errors.push(`workspace project ${project?.name ?? "<unknown>"} has unsafe path`);
    }
  }
  return errors;
}

export function validateCapabilityCatalog(catalog) {
  const errors = [];
  const ids = new Set();
  for (const capability of catalog?.capabilities ?? []) {
    if (!capability?.id) errors.push("capability is missing id");
    if (ids.has(capability?.id)) errors.push(`capabilities contains duplicate id: ${capability.id}`);
    ids.add(capability?.id);
    if (!riskLevels.has(capability?.risk)) errors.push(`capability ${capability?.id ?? "<unknown>"} has invalid risk level`);
    if (capability?.risk === "L3") errors.push(`capability ${capability.id} uses forbidden risk level L3`);
  }
  return errors;
}
```

```js
// src/lib/config.js
import path from "node:path";
import { parse } from "yaml";
import { readUtf8 } from "./files.js";

export async function loadYaml(cwd, relativePath) {
  return parse(await readUtf8(path.join(cwd, relativePath)));
}

export async function loadRepositoryConfig(cwd) {
  const [saber, workspace, capabilities] = await Promise.all([
    loadYaml(cwd, "saber.yaml"),
    loadYaml(cwd, "workspace.yaml"),
    loadYaml(cwd, "mcp/capabilities.yaml")
  ]);
  return { saber, workspace, capabilities };
}
```

```js
// src/lib/files.js
import { readFile } from "node:fs/promises";

export async function readUtf8(filePath) {
  return readFile(filePath, "utf8");
}
```

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/validation.test.js`
Expected: both validation tests pass.

- [ ] **Step 5: Commit validation**

```bash
git add src/lib/files.js src/lib/config.js src/lib/validation.js tests/validation.test.js
git commit -m "feat: validate workspace and capability catalogs"
```

## Task 3: Add repository assets and the validate command

**Files:**
- Create: `saber.yaml`
- Create: `workspace.yaml`
- Create: `mcp/capabilities.yaml`
- Create: `roles/ba.md`
- Create: `roles/dev.md`
- Create: `roles/qa.md`
- Create: `workflows/requirements/README.md`
- Create: `workflows/develop/README.md`
- Create: `workflows/test/README.md`
- Create: `skills/clarify-requirements.md`
- Create: `src/commands/validate.js`
- Modify: `src/cli.js`
- Create: `tests/validate-command.test.js`

- [ ] **Step 1: Write failing command behavior tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("validate reports a valid repository as JSON", async () => {
  const result = await runCli(["validate", "--json"], { cwd: process.cwd() });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, errors: [] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/validate-command.test.js`
Expected: FAIL because the command still returns the placeholder implementation text.

- [ ] **Step 3: Add initial assets and command implementation**

```yaml
# saber.yaml
schemaVersion: 1
name: saber
safety:
  externalWriteConfirmation: true
  forbiddenRiskLevels:
    - L3
```

```yaml
# workspace.yaml
schemaVersion: 1
projects: []
```

```yaml
# mcp/capabilities.yaml
schemaVersion: 1
capabilities:
  - id: jira.read
    risk: L0
  - id: jira.update
    risk: L2
  - id: gitlab.mr.read
    risk: L0
  - id: gitlab.mr.create
    risk: L2
```

```js
// src/commands/validate.js
import { loadRepositoryConfig } from "../lib/config.js";
import { validateCapabilityCatalog, validateWorkspace } from "../lib/validation.js";

export async function validateRepository(cwd) {
  const { workspace, capabilities } = await loadRepositoryConfig(cwd);
  const errors = [
    ...validateWorkspace(workspace),
    ...validateCapabilityCatalog(capabilities)
  ];
  return { ok: errors.length === 0, errors };
}
```

Replace the `validate` branch in `runCli` with a call to `validateRepository(cwd)`. Render `JSON.stringify(result) + "\\n"` when `--json` is present; render `Validation passed\\n` on success otherwise; render each error prefixed by `- ` and exit code 1 on failure.

Create each role/workflow/skill file with a title, declared input, output, and handoff section. The BA workflow must require a Jira source fingerprint; the Dev workflow must require target repositories; the QA workflow must require test evidence references.

- [ ] **Step 4: Run all tests and manual CLI verification**

Run: `npm test`
Run: `node src/cli.js validate --json`
Expected: all tests pass and the command prints `{"ok":true,"errors":[]}`.

- [ ] **Step 5: Commit assets and validation command**

```bash
git add saber.yaml workspace.yaml mcp roles workflows skills src/commands/validate.js src/cli.js tests/validate-command.test.js
git commit -m "feat: add validated team asset baseline"
```

## Task 4: Implement doctor and read-only project status

**Files:**
- Create: `src/lib/git.js`
- Create: `src/commands/doctor.js`
- Create: `src/commands/status.js`
- Modify: `src/cli.js`
- Create: `tests/doctor.test.js`
- Create: `tests/status.test.js`

- [ ] **Step 1: Write failing doctor and status tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeProject } from "../src/commands/status.js";

test("summarizeProject reports a missing checkout without invoking git", () => {
  const result = summarizeProject(
    { name: "frontend", path: "projects/frontend" },
    "/repo",
    { exists: () => false, gitStatus: () => { throw new Error("not called"); } }
  );

  assert.deepEqual(result, { name: "frontend", path: "projects/frontend", state: "missing" });
});
```

```js
import assert from "node:assert/strict";
import test from "node:test";
import { doctor } from "../src/commands/doctor.js";

test("doctor fails when validation has errors", async () => {
  const result = await doctor("/repo", {
    validate: async () => ({ ok: false, errors: ["bad configuration"] }),
    gitVersion: () => "git version 2.45.0",
    nodeVersion: "v20.0.0"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["bad configuration"]);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `node --test tests/doctor.test.js tests/status.test.js`
Expected: FAIL because the command modules do not exist.

- [ ] **Step 3: Implement injected status and doctor functions**

```js
// src/commands/status.js
import path from "node:path";

export function summarizeProject(project, cwd, dependencies) {
  const absolutePath = path.join(cwd, project.path);
  if (!dependencies.exists(absolutePath)) {
    return { name: project.name, path: project.path, state: "missing" };
  }
  const status = dependencies.gitStatus(absolutePath);
  return {
    name: project.name,
    path: project.path,
    state: status.dirty ? "dirty" : "clean",
    branch: status.branch
  };
}
```

```js
// src/commands/doctor.js
export async function doctor(cwd, dependencies) {
  const validation = await dependencies.validate(cwd);
  return {
    ok: validation.ok,
    node: dependencies.nodeVersion,
    git: dependencies.gitVersion(),
    errors: validation.errors
  };
}
```

Implement `gitStatus` with `spawnSync("git", ["-C", repositoryPath, "status", "--porcelain=v1", "--branch"], { encoding: "utf8" })`. Parse the first line beginning with `## ` for a branch name, and mark dirty when any later line is non-empty. Wire `doctor` and `status` into `runCli`; both commands must support `--json` and must never write to Git.

- [ ] **Step 4: Run full verification**

Run: `npm test`
Run: `node src/cli.js doctor --json`
Run: `node src/cli.js status --json`
Expected: all tests pass; doctor reports Node/Git/config health; status prints an empty project array for the initial catalog.

- [ ] **Step 5: Commit doctor and status**

```bash
git add src/lib/git.js src/commands/doctor.js src/commands/status.js src/cli.js tests/doctor.test.js tests/status.test.js
git commit -m "feat: add doctor and workspace status commands"
```

## Task 5: Add documentation and CI verification

**Files:**
- Create: `README.md`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Test: `package.json` scripts

- [ ] **Step 1: Write the CI contract test**

Create `tests/repository-contract.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";

test("repository contains its required neutral asset files", async () => {
  for (const file of [
    "saber.yaml",
    "workspace.yaml",
    "mcp/capabilities.yaml",
    "roles/ba.md",
    "roles/dev.md",
    "roles/qa.md"
  ]) {
    await access(file);
  }
  assert.ok(true);
});
```

- [ ] **Step 2: Run it to verify it fails before the asset files are present**

Run: `node --test tests/repository-contract.test.js`
Expected: FAIL only if Task 3 assets were not created. If Task 3 is complete, record that the test passes as regression coverage and continue.

- [ ] **Step 3: Write README and CI workflow**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
      - run: node src/cli.js validate --json
```

README must include: Node 20+ and Git prerequisites; `npm ci`; `npm test`; `node src/cli.js validate`; `doctor`; `status`; a warning that no L2 action is implemented yet; and a minimal `workspace.yaml` project entry example using `projects/frontend`.

Add `node_modules/`, `coverage/`, `.saber/`, `projects/`, `.superpowers/` and `.idea/` to `.gitignore`.

- [ ] **Step 4: Run the full local release gate**

Run: `npm ci`
Run: `npm test`
Run: `node src/cli.js validate --json`
Run: `node src/cli.js doctor --json`
Run: `git status --short`
Expected: dependency install, tests and read-only CLI checks exit 0; status contains only the intended documentation/CI changes.

- [ ] **Step 5: Commit the developer experience**

```bash
git add README.md .github/workflows/ci.yml .gitignore tests/repository-contract.test.js package-lock.json
git commit -m "docs: add Saber setup guide and CI"
```

## Plan self-review

- Spec coverage: Tasks 1-5 implement the local foundation named in the approved spec: root config, neutral assets, capability risk checks, Codex/Claude-neutral asset contract, workspace visibility, L0/L1-safe commands, CI, and first-run documentation.
- Intentional gaps: Jira/GitLab connectors, L2 previews, Codex/Claude materialization, workitem mutation, remote test integration, lock files and L3 actions are deferred by the approved scope boundary.
- Placeholder scan: No unresolved markers or unbounded error-handling instruction appears; every code-bearing task names exact files, tests, commands and expected outcomes.
- Type consistency: `runCli`, `validateRepository`, `doctor`, `summarizeProject`, `validateWorkspace`, and `validateCapabilityCatalog` use the same names in definition and tests.
