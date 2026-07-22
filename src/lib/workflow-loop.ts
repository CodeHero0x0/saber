import { SaberError } from "./errors.js";

export const workflowStates = [
  "ba-clarify",
  "dev-build",
  "qa-verify",
  "dev-fix",
  "ba-accept",
  "paused",
  "done",
] as const;

export type WorkflowState = (typeof workflowStates)[number];
export type ActiveWorkflowState = Exclude<WorkflowState, "paused" | "done">;

export const workflowResults = [
  "ready",
  "pass",
  "fail",
  "accept",
  "reject",
  "blocked",
  "paused",
] as const;

export type WorkflowResult = (typeof workflowResults)[number];
export type WorkflowRole = "ba" | "dev" | "qa";

const roles: Record<ActiveWorkflowState, WorkflowRole> = {
  "ba-clarify": "ba",
  "dev-build": "dev",
  "qa-verify": "qa",
  "dev-fix": "dev",
  "ba-accept": "ba",
};

const transitions: Partial<Record<ActiveWorkflowState, Partial<Record<WorkflowResult, WorkflowState>>>> = {
  "ba-clarify": { ready: "dev-build" },
  "dev-build": { ready: "qa-verify" },
  "qa-verify": { pass: "ba-accept", fail: "dev-fix" },
  "dev-fix": { ready: "qa-verify" },
  "ba-accept": { accept: "done", reject: "dev-fix" },
};

export function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === "string" && workflowStates.includes(value as WorkflowState);
}

export function isActiveWorkflowState(value: unknown): value is ActiveWorkflowState {
  return isWorkflowState(value) && value !== "paused" && value !== "done";
}

export function isWorkflowResult(value: unknown): value is WorkflowResult {
  return typeof value === "string" && workflowResults.includes(value as WorkflowResult);
}

export function roleForState(state: WorkflowState): WorkflowRole | null {
  return isActiveWorkflowState(state) ? roles[state] : null;
}

/** Resolve one explicit state transition. Pause metadata is handled by the workitem layer. */
export function transition(state: WorkflowState, result: WorkflowResult): WorkflowState {
  if (!isActiveWorkflowState(state)) {
    throw new SaberError(`workflow state ${state} cannot advance`, 2);
  }
  if (result === "blocked" || result === "paused") {
    return "paused";
  }
  const next = transitions[state]?.[result];
  if (next === undefined) {
    throw new SaberError(`workflow result ${result} is invalid for state ${state}`, 2);
  }
  return next;
}

export function suggestedCommand(key: string, state: WorkflowState): string | null {
  if (state === "done") return null;
  if (state === "paused") return `saber resume ${key}`;
  const results: Record<ActiveWorkflowState, string> = {
    "ba-clarify": "ready",
    "dev-build": "ready",
    "qa-verify": "pass|fail",
    "dev-fix": "ready",
    "ba-accept": "accept|reject",
  };
  return `saber next ${key} --result ${results[state]}`;
}
