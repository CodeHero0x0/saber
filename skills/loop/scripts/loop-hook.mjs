#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  approvePending,
  completionIssues,
  deliveryFingerprint,
  loadActiveState,
  nextPrompt,
  saveState,
  workspaceFingerprint,
} from "./loop-state.mjs";

function readInput() {
  try {
    const text = readFileSync(0, "utf8").trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function deny(event, reason) {
  output({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function extractCommand(input) {
  return typeof input?.command === "string" ? input.command.trim() : "";
}

function extractExitCode(response) {
  if (response === null || response === undefined) return undefined;
  if (typeof response === "object") {
    if (Number.isInteger(response.exit_code)) return response.exit_code;
    if (Number.isInteger(response.exitCode)) return response.exitCode;
    for (const value of Object.values(response)) {
      const nested = extractExitCode(value);
      if (nested !== undefined) return nested;
    }
  }
  if (typeof response === "string") {
    const match = /(?:exit(?:ed)?(?: with)?(?: code)?|exit_code)[=: ]+(\d+)/iu.exec(response);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function context(state) {
  return [
    `Saber Loop ${state.requirementId} is ${state.status} in phase ${state.phase}.`,
    `Frozen evidence: ${state.evidence.path}@${state.evidence.commit}.`,
    `Member artifacts: ${state.artifactDirectory}.`,
    `Current tickets: ${state.tickets.map(({ id, status }) => `${id}:${status}`).join(", ") || "none"}.`,
    `Approvals: grill=${state.approvals.grill}, spec=${state.approvals.spec}, tickets=${state.approvals.tickets}.`,
    "Do not modify Story or architecture evidence. Do not cross a pending human checkpoint.",
  ].join("\n");
}

function elapsedMinutes(state) {
  return (Date.now() - Date.parse(state.createdAt)) / 60_000;
}

function preToolUse(input, active) {
  const { state } = active;
  const event = input.hook_event_name || "PreToolUse";
  if (state.status === "awaiting-human") return deny(event, `Saber Loop is waiting for ${state.pendingCheckpoint} approval.`);
  if (["paused", "blocked", "cancelled", "complete"].includes(state.status)) return deny(event, `Saber Loop is ${state.status}.`);

  const serialized = JSON.stringify(input.tool_input ?? {});
  const command = extractCommand(input.tool_input);
  if (/\bgit\s+(?:[^\s]+\s+)*(?:push|pull|fetch)\b/iu.test(command)) {
    return deny(event, "Saber Loop never fetches, pulls, or pushes.");
  }
  if (!state.policy.allowBusinessCommit && /\bgit\s+(?:[^\s]+\s+)*commit\b/iu.test(command)) {
    return deny(event, "Saber Loop leaves Git commits to the member.");
  }

  const evidenceTokens = [state.evidence.path, state.evidence.path.replaceAll("/", "\\")];
  const mentionsEvidence = evidenceTokens.some((token) => serialized.includes(token));
  const artifactTokens = [state.artifactDirectory, state.artifactDirectory.replaceAll("/", "\\")];
  const mentionsOwnArtifacts = artifactTokens.some((token) => serialized.includes(token));
  const mentionsAnySpecs = /(?:^|[\\/])specs[\\/]/u.test(serialized);
  const writeTool = ["apply_patch", "Edit", "Write"].includes(input.tool_name);
  const mutatingShell = /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|touch|truncate|tee|sed\s+-i|perl\s+-pi)\b|>>?|\bapply_patch\b/iu.test(command);
  if (mentionsEvidence && (writeTool || mutatingShell)) {
    return deny(event, "The frozen Story or technical-design evidence is read-only during Saber Loop.");
  }
  if (mentionsAnySpecs && !mentionsOwnArtifacts && (writeTool || mutatingShell)) {
    return deny(event, "Saber Loop may modify only the active member's spec artifacts.");
  }
  const approvedArtifacts = [
    state.approvals.grill && "DECISIONS.md",
    state.approvals.spec && "SPEC.md",
    state.approvals.tickets && "TICKETS.md",
  ].filter(Boolean);
  if (mentionsOwnArtifacts && approvedArtifacts.some((name) => serialized.includes(name)) && (writeTool || mutatingShell)) {
    return deny(event, "Approved member artifacts are frozen for this Loop run.");
  }
  if (!state.approvals.tickets && (writeTool || mutatingShell)) {
    const stateCommand = command.includes("loop-state.mjs");
    if (!mentionsOwnArtifacts && !stateCommand) {
      return deny(event, "Business code cannot change before grill, spec, and tickets are approved.");
    }
  }
}

function postToolUse(input, active) {
  const { path, state } = active;
  const command = extractCommand(input.tool_input);
  if (!state.verificationCommands.includes(command)) return;
  const exitCode = extractExitCode(input.tool_response);
  if (exitCode === undefined) return;
  state.verificationEvidence[command] = {
    exitCode,
    recordedAt: new Date().toISOString(),
    workspaceFingerprint: workspaceFingerprint(state.projectRoot),
  };
  saveState(path, state);
}

function stop(active) {
  const { path, state } = active;
  if (state.status === "awaiting-human") {
    return output({ continue: false, stopReason: `Awaiting ${state.pendingCheckpoint} approval. Reply exactly 确认 to approve.` });
  }
  if (["paused", "blocked", "cancelled", "complete"].includes(state.status)) {
    return output({ continue: false, stopReason: `Saber Loop is ${state.status}.` });
  }
  if (elapsedMinutes(state) >= state.limits.maxMinutes) {
    state.status = "blocked";
    state.blockedReason = "time limit exhausted";
    saveState(path, state);
    return output({ continue: false, stopReason: state.blockedReason });
  }

  state.iteration += 1;
  const fingerprint = deliveryFingerprint(state);
  if (state.lastContinuationFingerprint === fingerprint) state.noProgressIterations += 1;
  else state.noProgressIterations = 0;
  state.lastContinuationFingerprint = fingerprint;
  if (state.iteration >= state.limits.maxIterations || state.noProgressIterations >= state.limits.maxNoProgressIterations) {
    state.status = "blocked";
    state.blockedReason = state.iteration >= state.limits.maxIterations ? "iteration limit exhausted" : "three consecutive continuations made no progress";
    saveState(path, state);
    return output({ continue: false, stopReason: state.blockedReason });
  }
  saveState(path, state);
  return output({ decision: "block", reason: nextPrompt(state) });
}

function main() {
  const input = readInput();
  let active;
  try {
    active = loadActiveState(input.cwd || process.cwd());
  } catch {
    return;
  }
  if (!active) return;
  const event = input.hook_event_name;
  if (event === "SessionStart") {
    return output({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context(active.state) } });
  }
  if (event === "UserPromptSubmit") {
    if (String(input.prompt ?? "").trim() === "确认" && active.state.status === "awaiting-human") {
      const state = approvePending(active.path, active.state);
      return output({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `Approved ${state.approvals.grill && !state.approvals.spec ? "grill" : state.approvals.spec && !state.approvals.tickets ? "spec" : "tickets"} checkpoint. Continue phase ${state.phase}.` } });
    }
    return;
  }
  if (event === "PreToolUse") return preToolUse(input, active);
  if (event === "PostToolUse") return postToolUse(input, active);
  if (event === "Stop") return stop(active);
  if (event === "PreCompact") {
    active.state.checkpointedAt = new Date().toISOString();
    saveState(active.path, active.state);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Saber Loop hook failed"}\n`);
  process.exitCode = 1;
}
