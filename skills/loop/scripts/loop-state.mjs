#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const memberPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const requirementPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const phases = new Set(["grilling", "specifying", "ticketing", "implementing", "verifying", "simplifying", "reviewing"]);
const checkpoints = new Set(["grill", "spec", "tickets"]);

function fail(message) {
  const error = new Error(message);
  error.saberLoop = true;
  throw error;
}

function git(cwd, args, allowFailure = false) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    const detail = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function normalizeId(value) {
  const normalized = value.toLowerCase().replace(/\.md$/u, "").replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!memberPattern.test(normalized)) fail(`invalid identifier: ${value}`);
  return normalized;
}

function normalizeRequirementId(value) {
  const normalized = value.replace(/\.md$/iu, "").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!requirementPattern.test(normalized)) fail(`invalid requirement identifier: ${value}`);
  return normalized;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function findTeamRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "saber.yaml")) && existsSync(join(current, "projects"))) return current;
    const parent = dirname(current);
    if (parent === current) fail("Saber team workspace not found");
    current = parent;
  }
}

export function findProjectRoot(start = process.cwd()) {
  const root = git(start, ["rev-parse", "--show-toplevel"], true);
  if (root === undefined) fail("run Saber Loop from a Git business repository");
  return resolve(root);
}

function parseSettings(root) {
  const text = readFileSync(join(root, "saber.yaml"), "utf8");
  const stringSetting = (name, fallback) => new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, "mu").exec(text)?.[1] ?? fallback;
  const integerSetting = (name, fallback) => {
    const raw = stringSetting(name, String(fallback));
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) fail(`invalid loop setting ${name}`);
    return value;
  };
  return {
    evidenceBranch: stringSetting("evidenceBranch", "origin/main"),
    maxIterations: integerSetting("maxIterations", 8),
    maxNoProgressIterations: integerSetting("maxNoProgressIterations", 3),
    maxMinutes: integerSetting("maxMinutes", 60),
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walkMarkdown(root, found = []) {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkMarkdown(path, found);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(path);
  }
  return found;
}

function frontmatterId(path) {
  const head = readFileSync(path, "utf8").slice(0, 4000);
  return /^id:\s*["']?([^\s"']+)["']?\s*$/imu.exec(head)?.[1];
}

function resolveEvidence(root, value) {
  const allowedRoots = [join(root, "requirements"), join(root, "architecture")];
  let matches;
  if (value.includes("/") || value.includes("\\") || value.toLowerCase().endsWith(".md")) {
    matches = [isAbsolute(value) ? resolve(value) : resolve(root, value)];
  } else {
    const wanted = value.toLowerCase();
    matches = allowedRoots.flatMap((directory) => walkMarkdown(directory)).filter((path) => {
      return basename(path, ".md").toLowerCase() === wanted || frontmatterId(path)?.toLowerCase() === wanted;
    });
  }
  matches = matches.filter((path) => existsSync(path) && statSync(path).isFile() && allowedRoots.some((directory) => isInside(directory, path)));
  if (matches.length === 0) fail(`no committed Story or technical design matches ${value}`);
  if (matches.length > 1) fail(`more than one evidence file matches ${value}; pass an explicit path`);
  return matches[0];
}

function memberId(root) {
  const path = join(root, ".saber", "member.json");
  if (existsSync(path)) {
    const id = readJson(path).id;
    if (typeof id !== "string" || !memberPattern.test(id)) fail(".saber/member.json contains an invalid member id");
    return id;
  }
  const email = git(root, ["config", "user.email"], true);
  const name = git(root, ["config", "user.name"], true);
  const candidate = normalizeId(email?.split("@")[0] || name || process.env.USER || "member");
  writeJson(path, { id: candidate });
  return candidate;
}

function verifyEvidence(root, path, evidenceBranch) {
  const relativePath = relative(root, path).replaceAll(sep, "/");
  if (git(root, ["status", "--porcelain", "--", relativePath])) fail(`evidence has uncommitted changes: ${relativePath}`);
  const commit = git(root, ["log", "-1", "--format=%H", "--", relativePath]);
  if (!commit) fail(`evidence is not committed: ${relativePath}`);
  if (git(root, ["rev-parse", "--verify", evidenceBranch], true) === undefined) {
    fail(`configured evidence branch is unavailable locally: ${evidenceBranch}`);
  }
  if (git(root, ["merge-base", "--is-ancestor", commit, evidenceBranch], true) === undefined) {
    fail(`evidence commit is not contained by ${evidenceBranch}: ${relativePath}`);
  }
  return { path: relativePath, commit, digest: `sha256:${sha256(readFileSync(path))}` };
}

function hashTree(path, hash) {
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (status.isSymbolicLink()) {
    hash.update(`link:${path}`);
    return;
  }
  if (status.isDirectory()) {
    for (const name of readdirSync(path).sort()) hashTree(join(path, name), hash);
    return;
  }
  hash.update(`file:${path}:`);
  hash.update(readFileSync(path));
}

export function workspaceFingerprint(projectRoot) {
  const hash = createHash("sha256");
  const status = git(projectRoot, ["status", "--porcelain=v1", "-z"], true) ?? "";
  hash.update(status);
  hash.update(git(projectRoot, ["diff", "--binary", "HEAD"], true) ?? "");
  hash.update(git(projectRoot, ["diff", "--binary", "--cached"], true) ?? "");
  for (const entry of status.split("\0")) {
    if (!entry.startsWith("?? ")) continue;
    hashTree(join(projectRoot, entry.slice(3)), hash);
  }
  return `sha256:${hash.digest("hex")}`;
}

function artifactsFingerprint(state) {
  const hash = createHash("sha256");
  hashTree(resolve(state.teamRoot, state.artifactDirectory), hash);
  return `sha256:${hash.digest("hex")}`;
}

function artifactPath(state, name) {
  return join(state.teamRoot, state.artifactDirectory, name);
}

function artifactDigest(state, name) {
  const path = artifactPath(state, name);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`required member artifact is missing: ${name}`);
  return `sha256:${sha256(readFileSync(path))}`;
}

function ticketGraphDigest(tickets) {
  return sha256(JSON.stringify(tickets.map(({ id, blockers = [] }) => ({ id, blockers }))));
}

export function deliveryFingerprint(state) {
  const semanticState = {
    phase: state.phase,
    status: state.status,
    pendingCheckpoint: state.pendingCheckpoint,
    approvals: state.approvals,
    tickets: state.tickets,
    verificationEvidence: state.verificationEvidence,
    reviews: state.reviews,
  };
  return sha256(`${workspaceFingerprint(state.projectRoot)}:${artifactsFingerprint(state)}:${JSON.stringify(semanticState)}`);
}

function activePointerPath(projectRoot) {
  return join(projectRoot, ".saber", "work", "active-loop.json");
}

export function loadActiveState(cwd = process.cwd()) {
  const projectRoot = findProjectRoot(cwd);
  const pointer = activePointerPath(projectRoot);
  if (!existsSync(pointer)) return undefined;
  const { statePath } = readJson(pointer);
  if (typeof statePath !== "string" || !existsSync(statePath)) return undefined;
  return { path: statePath, state: readJson(statePath) };
}

export function saveState(path, state) {
  state.updatedAt = new Date().toISOString();
  writeJson(path, state);
}

function start(evidenceValue) {
  if (!evidenceValue) fail("usage: loop-state.mjs start <requirement-id-or-path>");
  const projectRoot = findProjectRoot();
  const existing = loadActiveState(projectRoot);
  if (existing && !["complete", "blocked", "cancelled"].includes(existing.state.status)) {
    fail(`an active loop already exists for ${existing.state.requirementId}`);
  }
  const teamRoot = findTeamRoot(projectRoot);
  if (!isInside(join(teamRoot, "projects"), projectRoot)) fail("business repository must be nested under the Saber projects directory");
  const settings = parseSettings(teamRoot);
  const evidencePath = resolveEvidence(teamRoot, evidenceValue);
  const evidence = verifyEvidence(teamRoot, evidencePath, settings.evidenceBranch);
  const requirementId = normalizeRequirementId(frontmatterId(evidencePath) || basename(evidencePath, ".md"));
  const member = memberId(teamRoot);
  const artifactDirectory = join("specs", requirementId, member).replaceAll(sep, "/");
  const artifactRoot = join(teamRoot, artifactDirectory);
  mkdirSync(artifactRoot, { recursive: true });
  const decisions = join(artifactRoot, "DECISIONS.md");
  if (!existsSync(decisions)) {
    writeFileSync(decisions, `# Decisions\n\nRequirement: ${requirementId}\nEvidence: ${evidence.path}@${evidence.commit}\n\n`, "utf8");
  }
  const statePath = join(teamRoot, ".saber", "work", "loops", requirementId, member, "state.json");
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    requirementId,
    member,
    teamRoot,
    projectRoot,
    artifactDirectory,
    evidence,
    evidenceFrozenAt: now,
    baselineWorkspaceFingerprint: null,
    status: "running",
    phase: "grilling",
    pendingCheckpoint: null,
    approvals: { grill: false, spec: false, tickets: false },
    approvedArtifactDigests: {},
    approvedTicketGraphDigest: null,
    tickets: [],
    verificationCommands: [],
    verificationEvidence: {},
    reviews: { ponytail: "pending", code: "pending" },
    iteration: 0,
    noProgressIterations: 0,
    lastContinuationFingerprint: null,
    lastProgress: null,
    limits: {
      maxIterations: settings.maxIterations,
      maxNoProgressIterations: settings.maxNoProgressIterations,
      maxMinutes: settings.maxMinutes,
    },
    policy: { allowBusinessCommit: false },
    createdAt: now,
    updatedAt: now,
  };
  saveState(statePath, state);
  writeJson(activePointerPath(projectRoot), { statePath });
  state.baselineWorkspaceFingerprint = workspaceFingerprint(projectRoot);
  saveState(statePath, state);
  return state;
}

export function approvePending(path, state) {
  const checkpoint = state.pendingCheckpoint;
  if (!checkpoints.has(checkpoint)) fail("there is no pending Saber Loop checkpoint");
  state.approvals[checkpoint] = true;
  const artifact = checkpoint === "grill" ? "DECISIONS.md" : checkpoint === "spec" ? "SPEC.md" : "TICKETS.md";
  if (checkpoint === "tickets" && workspaceFingerprint(state.projectRoot) !== state.baselineWorkspaceFingerprint) {
    fail("business workspace changed before tickets approval; restore it or cancel this Loop");
  }
  state.approvedArtifactDigests[checkpoint] = artifactDigest(state, artifact);
  if (checkpoint === "tickets") state.approvedTicketGraphDigest = ticketGraphDigest(state.tickets);
  state.pendingCheckpoint = null;
  state.status = "running";
  state.phase = checkpoint === "grill" ? "specifying" : checkpoint === "spec" ? "ticketing" : "implementing";
  saveState(path, state);
  return state;
}

export function completionIssues(state) {
  const issues = [];
  for (const checkpoint of checkpoints) if (!state.approvals[checkpoint]) issues.push(`${checkpoint} approval missing`);
  for (const [checkpoint, artifact] of [["grill", "DECISIONS.md"], ["spec", "SPEC.md"], ["tickets", "TICKETS.md"]]) {
    if (!state.approvals[checkpoint]) continue;
    try {
      if (artifactDigest(state, artifact) !== state.approvedArtifactDigests[checkpoint]) issues.push(`${artifact} changed after approval`);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${artifact} is invalid`);
    }
  }
  if (state.approvals.tickets && ticketGraphDigest(state.tickets) !== state.approvedTicketGraphDigest) {
    issues.push("ticket graph changed after approval");
  }
  if (state.tickets.length === 0) issues.push("no tickets registered");
  for (const ticket of state.tickets) if (ticket.status !== "complete") issues.push(`ticket ${ticket.id} is ${ticket.status}`);
  if (state.verificationCommands.length === 0) issues.push("no verification commands registered");
  const currentFingerprint = workspaceFingerprint(state.projectRoot);
  for (const command of state.verificationCommands) {
    const evidence = state.verificationEvidence[command];
    if (!evidence || evidence.exitCode !== 0) issues.push(`verification has not passed: ${command}`);
    else if (evidence.workspaceFingerprint !== currentFingerprint) issues.push(`verification is stale after workspace changes: ${command}`);
  }
  if (state.reviews.ponytail !== "pass") issues.push("ponytail review has not passed");
  if (state.reviews.code !== "pass") issues.push("code review has not passed");
  if (!existsSync(artifactPath(state, "RESULT.md"))) issues.push("RESULT.md is missing");
  return issues;
}

export function nextPrompt(state) {
  const artifactRoot = join(state.teamRoot, state.artifactDirectory);
  const prompts = {
    grilling: `Continue grilling only unresolved points for ${state.requirementId}; update ${join(artifactRoot, "DECISIONS.md")}, then create the grill checkpoint.`,
    specifying: `Create or refine ${join(artifactRoot, "SPEC.md")} from the frozen evidence and decisions, then create the spec checkpoint.`,
    ticketing: `Create or refine ${join(artifactRoot, "TICKETS.md")}, register its vertical tickets, then create the tickets checkpoint.`,
    implementing: `Continue the next unblocked ticket for ${state.requirementId}; implement and collect fresh verification evidence.`,
    verifying: `Run the registered verification commands and address any failure before stopping.`,
    simplifying: "Run ponytail-review, resolve or explicitly waive relevant complexity findings, then verify again.",
    reviewing: "Run the final normal code review and satisfy every blocking finding before completion.",
  };
  return prompts[state.phase] ?? `Continue the approved Saber Loop phase ${state.phase}.`;
}

function mutate(args) {
  const active = loadActiveState();
  if (!active) fail("no active Saber Loop");
  const { path, state } = active;
  const [command, ...rest] = args;
  if (command === "status") return state;
  if (command === "phase") {
    if (!phases.has(rest[0])) fail(`invalid phase: ${rest[0]}`);
    if (state.status === "awaiting-human") fail("approve or cancel the pending checkpoint first");
    state.phase = rest[0];
    state.status = "running";
  } else if (command === "checkpoint") {
    const checkpoint = rest[0];
    if (!checkpoints.has(checkpoint)) fail(`invalid checkpoint: ${checkpoint}`);
    state.pendingCheckpoint = checkpoint;
    state.phase = `awaiting-${checkpoint}-approval`;
    state.status = "awaiting-human";
  } else if (command === "approve") {
    return approvePending(path, state);
  } else if (command === "tickets") {
    if (state.approvals.tickets) fail("approved ticket graph is frozen; cancel and start a new loop to replace it");
    if (rest.length === 0) fail("register at least one ticket id");
    state.tickets = [...new Set(rest.map(normalizeId))].map((id) => ({ id, blockers: [], status: "pending" }));
  } else if (command === "ticket-add") {
    if (state.approvals.tickets) fail("approved ticket graph is frozen; cancel and start a new loop to replace it");
    const [rawId, ...rawBlockers] = rest;
    if (!rawId) fail("usage: ticket-add <id> [blocker-id ...]");
    const id = normalizeId(rawId);
    const blockers = [...new Set(rawBlockers.map(normalizeId))];
    if (blockers.includes(id)) fail(`ticket ${id} cannot block itself`);
    const known = new Set(state.tickets.map((ticket) => ticket.id));
    for (const blocker of blockers) if (!known.has(blocker)) fail(`ticket blocker must be registered first: ${blocker}`);
    const existing = state.tickets.find((ticket) => ticket.id === id);
    if (existing) {
      existing.blockers = blockers;
    } else {
      state.tickets.push({ id, blockers, status: "pending" });
    }
  } else if (command === "ticket") {
    const [id, status] = rest;
    if (!id || !["pending", "running", "complete", "blocked"].includes(status)) fail("usage: ticket <id> pending|running|complete|blocked");
    const ticket = state.tickets.find((item) => item.id === id);
    if (!ticket) fail(`unknown ticket: ${id}`);
    if (["running", "complete"].includes(status)) {
      const incompleteBlockers = (ticket.blockers ?? []).filter((blocker) => state.tickets.find((item) => item.id === blocker)?.status !== "complete");
      if (incompleteBlockers.length > 0) fail(`ticket ${id} is blocked by ${incompleteBlockers.join(", ")}`);
    }
    ticket.status = status;
  } else if (command === "verify-command") {
    const value = rest.join(" ").trim();
    if (!value) fail("verification command must not be empty");
    if (!state.verificationCommands.includes(value)) state.verificationCommands.push(value);
  } else if (command === "review") {
    const [kind, result] = rest;
    if (!["ponytail", "code"].includes(kind) || !["pass", "fail"].includes(result)) fail("usage: review ponytail|code pass|fail");
    state.reviews[kind] = result;
  } else if (command === "progress") {
    state.noProgressIterations = 0;
    state.lastProgress = rest.join(" ").trim() || "progress recorded";
  } else if (command === "no-progress") {
    state.noProgressIterations += 1;
    state.lastProgress = rest.join(" ").trim() || "no progress";
    if (state.noProgressIterations >= state.limits.maxNoProgressIterations) {
      state.status = "blocked";
      state.blockedReason = state.lastProgress;
    }
  } else if (command === "pause") {
    state.status = "paused";
  } else if (command === "resume") {
    if (state.status !== "paused") fail("only a paused loop can resume");
    state.status = "running";
  } else if (command === "block") {
    state.status = "blocked";
    state.blockedReason = rest.join(" ").trim() || "blocked without a reason";
  } else if (command === "cancel") {
    state.status = "cancelled";
  } else if (command === "complete") {
    const issues = completionIssues(state);
    if (issues.length > 0) fail(`Loop cannot complete:\n- ${issues.join("\n- ")}`);
    state.status = "complete";
    state.phase = "complete";
    state.completedAt = new Date().toISOString();
  } else {
    fail(`unknown loop command: ${command}`);
  }
  saveState(path, state);
  return state;
}

async function main() {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const result = command === "start" ? start(rest.join(" ").trim()) : mutate([command, ...rest]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Saber Loop failed"}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
