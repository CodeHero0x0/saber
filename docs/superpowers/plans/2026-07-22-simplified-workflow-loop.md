# Simplified Workflow Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver compact daily commands, layered team/personal configuration, cross-tool role guidance, a mock workitem, and a BA-first development/testing loop.

**Architecture:** Keep the existing schema-v1 loader intact as a compatibility path, add a schema-v2 preset expander and a strictly limited local overlay, then pass the same resolved `RepositoryConfig` to all existing commands. Put workflow transitions in a pure state-machine module and persistence/rollback in the workitem module; expose them through a focused convenience-command module so existing low-level commands remain stable.

**Tech Stack:** TypeScript, Node.js 20, `yaml`, Node test runner through `tsx`, existing Saber filesystem/Git safety helpers.

---

## File Map

- Create `src/lib/presets.ts`: immutable standard repository preset and cloning helpers.
- Create `src/lib/local-config.ts`: parse and apply the restricted `saber.local.yaml` overlay.
- Modify `src/lib/config.ts`: route schema v1 to the legacy parser and schema v2 through preset expansion plus local overlay.
- Modify `src/lib/models.ts`: add local defaults/extensions and schema-v2 team input types without weakening resolved types.
- Create `src/lib/workflow-loop.ts`: pure states, transitions, role mapping and suggestions.
- Modify `src/lib/workitems.ts`: schema-v2 workflow metadata, compatibility reads, transactional transition/handoff writes.
- Create `src/commands/convenience.ts`: `setup`, `use`, `open`, `loop`, `next`, `pause`, `resume`, `demo`.
- Modify `src/cli.ts`: route and document convenience commands.
- Modify `src/commands/materialize.ts`: export parsing/format helpers only if required by `use`; avoid duplicated materialization behavior.
- Create `saber.local.example.yaml`: documented personal override template.
- Modify `.gitignore`: ignore `saber.local.yaml` while retaining its example.
- Replace `saber.yaml`: concise schema-v2 team configuration.
- Create `examples/mock-project/**`: complete DEMO-101 example and copyable initial template.
- Modify `README.md`: replace long commands with the daily path and retain advanced command references.
- Add/modify tests in `tests/config.test.ts`, `tests/workitems.test.ts`, `tests/cli.test.ts`, `tests/materialize.test.ts`, `tests/repository-assets.test.ts`, and `tests/acceptance.test.ts`.

### Task 1: Preset And Restricted Personal Configuration

**Files:**
- Create: `src/lib/presets.ts`
- Create: `src/lib/local-config.ts`
- Modify: `src/lib/config.ts`
- Modify: `src/lib/models.ts`
- Modify: `saber.yaml`
- Create: `saber.local.example.yaml`
- Modify: `.gitignore`
- Test: `tests/config.test.ts`
- Test: `tests/repository-assets.test.ts`

- [ ] **Step 1: Define the schema-v2 team input and personal overlay types**

Keep `RepositoryConfig` as the fully resolved runtime type. Add input-only types equivalent to:

```ts
export type TeamConfigV2 = {
  schemaVersion: 2;
  name: string;
  workspace: {
    tools?: { default?: ToolName };
    projects: ProjectConfig[];
  };
  externalSkills?: { preset: "standard" };
};

export type LocalConfig = {
  schemaVersion: 1;
  defaults?: { role?: RoleName; tool?: ToolName };
  projects?: Record<string, { repository?: string }>;
  extensions?: { skills?: string[]; capabilities?: string[] };
};
```

Expose resolved personal defaults separately on `RepositoryConfig.local`, without inserting personal skills into checked-in role profiles.

- [ ] **Step 2: Add the immutable standard preset**

Move the common safety, tool support, roles, capabilities, connectors and external asset catalog from the current `saber.yaml` into `standardPreset()` in `src/lib/presets.ts`. Return a fresh deep structure per call so commands cannot mutate shared process state.

- [ ] **Step 3: Parse and enforce the personal overlay**

`loadLocalConfig()` must treat a missing file as an empty overlay, reject symlinks and unknown keys, and validate:

```ts
if (capability.risk !== "L0" && capability.risk !== "L1") {
  throw new SaberError(`personal capability ${id} must be L0 or L1`, 2);
}
if (!teamProjectNames.has(projectName)) {
  throw new SaberError(`personal project ${projectName} is not declared by the team`, 2);
}
```

Project repositories may be supplied locally, but paths and project membership always come from `saber.yaml`.

- [ ] **Step 4: Add schema routing and merge order**

In `loadRepositoryConfig`, read `saber.yaml` once, inspect `schemaVersion`, preserve the current schema-v1 parser, and for version 2:

1. parse the concise team input;
2. clone the standard preset;
3. replace name/projects and optional team default tool;
4. parse/apply `saber.local.yaml`;
5. run existing cross-config validation before returning.

All parsing errors remain generic enough not to reproduce private config values.

- [ ] **Step 5: Replace repository configuration assets**

Make `saber.yaml` contain only schema version, name, workspace projects/default tool and the standard external-skill preset. Add comments to each user-editable field. Add `saber.local.example.yaml` with placeholders and update `.gitignore`:

```gitignore
/saber.local.yaml
!/saber.local.example.yaml
```

- [ ] **Step 6: Add configuration milestone tests**

Cover:

- old schema-v1 fixture still resolves;
- checked-in schema-v2 config expands to the existing capabilities, connectors and role profiles;
- explicit tool and project repository overrides merge correctly;
- unknown local keys, unknown projects, L2 capability requests and unsafe repository values fail;
- malformed local config does not echo its source or secrets;
- the example is tracked while a real local file is ignored.

- [ ] **Step 7: Run the configuration milestone**

Run:

```bash
npm run check
npm test -- --test-name-pattern="config|preset|local|repository"
npm run saber -- validate --json
```

Expected: exit 0; the checked-in configuration reports `"valid": true`.

### Task 2: BA-First Workitem State Machine

**Files:**
- Create: `src/lib/workflow-loop.ts`
- Modify: `src/lib/workitems.ts`
- Modify: `src/commands/workitem.ts`
- Modify: `templates/workitem/workitem.yaml`
- Test: `tests/workitems.test.ts`

- [ ] **Step 1: Implement pure transitions**

Define:

```ts
export type WorkflowState =
  | "ba-clarify" | "dev-build" | "qa-verify"
  | "dev-fix" | "ba-accept" | "paused" | "done";
export type WorkflowResult = "ready" | "pass" | "fail" | "accept" | "reject" | "blocked" | "paused";

export function transition(state: WorkflowState, result: WorkflowResult): WorkflowState
```

Encode only these active transitions:

```text
ba-clarify + ready  -> dev-build
dev-build  + ready  -> qa-verify
qa-verify  + fail   -> dev-fix
dev-fix    + ready  -> qa-verify
qa-verify  + pass   -> ba-accept
ba-accept  + reject -> dev-fix
ba-accept  + accept -> done
```

`blocked` and `paused` are handled as pause transitions from any active state. Reject every other combination with `SaberError` exit code 2.

- [ ] **Step 2: Add schema-v2 workflow metadata**

Extend normalized metadata with:

```ts
workflow: {
  state: WorkflowState;
  role: WorkitemRole | null;
  iteration: number;
  pausedFrom: Exclude<WorkflowState, "paused" | "done"> | null;
  pauseReason: string | null;
  updatedAt: string;
  history: WorkflowHistoryEntry[];
}
```

New workitems start at `ba-clarify`, iteration 0. Schema-v1 reads synthesize this initial workflow in memory; their first state write serializes schema version 2.

- [ ] **Step 3: Implement gates and safe transition persistence**

Add `advanceWorkitem`, `pauseWorkitem`, and `resumeWorkitem`. Before writes:

- validate role implied by current state;
- validate result and short text fields;
- compare a supplied fingerprint where the gate requires it;
- check required artifact paths and `repositories.yaml` validity;
- preflight workitem/handoff/temp paths for symlinks and collisions.

Generate new metadata and handoff content in an isolated temporary directory. Replace targets with backups and restore both old files if either promotion fails. Remove temporary artifacts after success or rollback.

- [ ] **Step 4: Extend status data**

Add current workflow, iteration, pause information and a safe next-command suggestion to `WorkitemStatusReport`. Preserve existing repository evidence and artifact reporting.

- [ ] **Step 5: Add state-machine milestone tests**

Test these complete sequences rather than isolated setters:

```text
ready -> ready -> pass -> accept
ready -> ready -> fail -> ready -> pass -> accept
ready -> ready -> pass -> reject -> ready -> pass -> accept
```

Also test pause/resume, blocked state, drift on gated transitions, version-1 upgrade, missing artifacts, illegal transitions, invalid roles/text and injected write failure rollback.

- [ ] **Step 6: Run the state-machine milestone**

Run:

```bash
npm run check
npm test -- --test-name-pattern="workitem|workflow|loop|transition|pause|resume"
```

Expected: exit 0 with all matched tests passing.

### Task 3: Convenience Commands And Cross-Tool Role Guidance

**Files:**
- Create: `src/commands/convenience.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/materialize.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/materialize.test.ts`
- Test: `tests/workitems.test.ts`

- [ ] **Step 1: Add shared convenience-command argument parsing**

Implement strict parsers for:

```text
setup [--apply --confirm] [--json]
use <ba|dev|qa> [--tool <tool>] [--project <name>] [--json]
open <key> [--json]
loop <key> [--json]
next <key> --result <result> [--summary ... --risk ... --next ... --fingerprint ...] [--json]
pause <key> --reason <text> [--json]
resume <key> [--fingerprint <hash>] [--json]
demo [DEMO-101] [--json]
```

Reject duplicate flags, unknown flags and unsupported positionals consistently with current commands.

- [ ] **Step 2: Implement `use` by calling materialization directly**

Resolve tool as explicit option, then `config.local.defaults.tool`, then team default. Call `materialize()` and format:

```text
Role BA is ready for Claude Code.
Start: claude .
Common:
- saber open <JIRA-KEY>
- saber next <JIRA-KEY> --result ready
- saber pause <JIRA-KEY> --reason <text>
```

Provide distinct BA, Dev and QA common-command lists for all three tools. JSON output includes role, tool, project, discovery root, start command and common commands.

- [ ] **Step 3: Implement `open`, `loop`, `next`, `pause`, and `resume`**

`open` renders the expanded workitem status. `loop` renders the fixed route plus current-state marker and safe history summaries. Mutation commands call Task 2 APIs; `next` defaults missing summary/risk/next to concise neutral records rather than requiring verbose flags for every transition.

- [ ] **Step 4: Implement `setup` orchestration**

`setup` performs repository validation and doctor checks, creates `saber.local.yaml` from the checked-in example only when absent, and delegates external updates using the same `--apply --confirm` pair. It must not overwrite a personal config or weaken existing update confirmation.

- [ ] **Step 5: Route commands and update CLI help**

Add top-level routing in `src/cli.ts`. List daily commands first, followed by an `Advanced commands` block containing the existing interfaces.

- [ ] **Step 6: Add command milestone tests**

Cover all nine role/tool combinations for `use`, personal and team default precedence, missing external skill recovery, concise text/JSON output, full loop rendering, mutation error exit codes and `setup` no-overwrite behavior.

- [ ] **Step 7: Run the command milestone**

Run:

```bash
npm run check
npm test -- --test-name-pattern="use|setup|open|loop|next|pause|resume|materialize"
npm run saber -- --help
```

Expected: exit 0; help lists daily commands before advanced commands.

### Task 4: Mock Project And Demo Copy

**Files:**
- Create: `examples/mock-project/saber.yaml`
- Create: `examples/mock-project/workitems/DEMO-101/workitem.yaml`
- Create: `examples/mock-project/workitems/DEMO-101/requirements.md`
- Create: `examples/mock-project/workitems/DEMO-101/design.md`
- Create: `examples/mock-project/workitems/DEMO-101/plan.md`
- Create: `examples/mock-project/workitems/DEMO-101/tests.md`
- Create: `examples/mock-project/workitems/DEMO-101/repositories.yaml`
- Create: `examples/mock-project/workitems/DEMO-101/handoffs/*.md`
- Create: `examples/mock-project/workitems/DEMO-101/decisions/README.md`
- Create: `templates/demo/DEMO-101/**`
- Modify: `src/commands/convenience.ts`
- Test: `tests/repository-assets.test.ts`
- Test: `tests/acceptance.test.ts`

- [ ] **Step 1: Add the completed learning example**

Write a credential-free frontend/backend example for an order-note character limit. Its workflow history and handoffs must show:

```text
BA ready -> Dev ready -> QA fail -> Dev fix ready -> QA pass -> BA accept
```

Use only `.example.test` URLs and non-sensitive fake commits/MR references.

- [ ] **Step 2: Add the fresh demo template**

Create the same requirement and repository shape under `templates/demo/DEMO-101`, but reset workflow to `ba-clarify`, iteration 0, empty history and starter artifacts.

- [ ] **Step 3: Implement safe demo copying**

Resolve the bundled template through `import.meta.url`, accept only the supported demo ID, ensure `workitems/` has no escaping symlink, and copy with exclusive creation semantics. If the destination exists, exit 2 without changing it.

- [ ] **Step 4: Validate mock assets and demo behavior**

Tests parse every YAML file, validate the completed history, reject credential-bearing URLs, copy the demo into a temporary Saber root, run `open` and `loop`, and prove a second copy does not overwrite edits.

- [ ] **Step 5: Run the example milestone**

Run:

```bash
npm run check
npm test -- --test-name-pattern="mock|demo|DEMO-101|acceptance"
```

Expected: exit 0 and all example/demo tests pass.

### Task 5: Documentation, Compatibility And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `roles/ba.md`
- Modify: `roles/dev.md`
- Modify: `roles/qa.md`
- Modify: `workflows/requirements/SKILL.md`
- Modify: `workflows/develop/SKILL.md`
- Modify: `workflows/test/SKILL.md`
- Modify: `workflows/fix/SKILL.md`
- Modify: `tests/acceptance.test.ts`
- Modify: `tests/repository-assets.test.ts`

- [ ] **Step 1: Update role and workflow commands**

Add a compact `## Commands` section to every role with `saber use`, `open`, valid `next` results and pause/resume examples. Update workflow gates to name their state IDs and valid transition results without duplicating the state-machine implementation.

- [ ] **Step 2: Rewrite README around the short path**

Keep only core capabilities and this quick path:

```bash
npm ci
cp .env.example .env
cp saber.local.example.yaml saber.local.yaml
npm run saber -- setup
npm run saber -- use ba
npm run saber -- demo
npm run saber -- open DEMO-101
npm run saber -- loop DEMO-101
```

Document `use ba|dev|qa --tool codex|claude|opencode`, configuration ownership and a compact advanced-command reference.

- [ ] **Step 3: Run compatibility acceptance tests**

Run the entire suite once and fix only regressions caused by this feature:

```bash
npm test
```

Expected: all tests pass, including existing action safety, external asset and materialization tests.

- [ ] **Step 4: Run final delivery verification**

Run fresh commands in this order:

```bash
npm test
npm run check
npm run build
node dist/cli.js validate --json
git diff --check
git status --short
```

Expected: tests report zero failures; check/build/diff exit 0; validation returns `{"valid":true,"errors":[]}`; status contains only intended files.

- [ ] **Step 5: Review the final diff and commit**

Inspect `git diff --stat`, `git diff --check`, and the changed config/example files for credentials. Commit coherent milestones or one final feature commit without including `.env`, `saber.local.yaml`, `.saber/`, `projects/`, build output or tool runtime projections.
