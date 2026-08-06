---
name: loop
description: Complete a pushed team Story or technical-design Markdown file through a bounded, resumable delivery loop with explicit human approval gates. Use when a member invokes /loop or asks Saber to take one requirement through grilling, a member-owned spec, tracer-bullet tickets, implementation, verification, Ponytail simplification, and final review.
---

# Saber Loop

Run from a Git business repository under a Saber team workspace. Treat the selected Story or technical design as frozen evidence for this run. Never edit evidence under `requirements/` or `architecture/`.

## Start or resume

Locate this Skill directory, then use its deterministic state script:

```bash
node <loop-skill>/scripts/loop-state.mjs start <requirement-id-or-path>
node <loop-skill>/scripts/loop-state.mjs status
```

`start` verifies that the evidence is committed and contained by the configured evidence branch. It creates member-owned artifacts under `specs/<requirement>/<member>/` and local state under `.saber/work/`. If an active loop exists, inspect it and resume instead of replacing it.

When the host exposes persisted goals, create one concise goal that points at the member `SPEC.md`; do not copy the full spec into the goal. Do not set a token budget unless the member requested one.

Read [references/phase-contracts.md](references/phase-contracts.md) before running a phase. Read [references/artifact-contracts.md](references/artifact-contracts.md) before writing shared artifacts.

## Run the phases

1. Load relevant facts with `team-knowledge`.
2. Apply `grill-me`/`grilling` only to gaps not answered by the frozen evidence. Record resolved decisions in `DECISIONS.md`, then run `checkpoint grill` and stop for the member.
3. After the member replies exactly `确认`, apply `to-spec` as a synthesis method. Write `SPEC.md` locally; never publish to a tracker. Run `checkpoint spec` and stop.
4. After confirmation, apply `to-tickets` as a vertical-slicing method. Write `TICKETS.md`, register ticket ids with `tickets`, run `checkpoint tickets`, and stop.
5. After confirmation, work the unblocked ticket frontier. Apply `implement` and `tdd`, but do not commit or push. Register verification commands before relying on them.
6. After each implementation slice, verify it, run `ponytail-review`, apply justified simplifications, and verify again. Mark the ticket complete only with fresh passing evidence.
7. After all tickets, run normal `code-review`. Ponytail never substitutes for correctness, security, or spec review.
8. Record both reviews, write `RESULT.md`, and run `complete`. If the validator refuses completion, continue only on the listed unmet contract. When native Goal mode is active, mark the Goal complete only after this validator succeeds.

Useful state commands:

```bash
node <loop-skill>/scripts/loop-state.mjs phase specifying
node <loop-skill>/scripts/loop-state.mjs checkpoint spec
node <loop-skill>/scripts/loop-state.mjs ticket-add 01-foundation
node <loop-skill>/scripts/loop-state.mjs ticket-add 02-behavior 01-foundation
node <loop-skill>/scripts/loop-state.mjs verify-command "npm test"
node <loop-skill>/scripts/loop-state.mjs ticket 01-foundation complete
node <loop-skill>/scripts/loop-state.mjs review ponytail pass
node <loop-skill>/scripts/loop-state.mjs review code pass
node <loop-skill>/scripts/loop-state.mjs complete
```

## Boundaries

- A Hook-generated continuation is permission to continue the current approved phase, not to cross a human checkpoint.
- The only short approval token is exact `确认`, and it approves only the single pending checkpoint shown in the current state.
- Never fetch, pull, push, publish, or modify a tracker. Never edit another member's artifacts.
- Stop on ambiguity, missing authority, external writes, unstable verification, exhausted limits, or three consecutive no-progress continuations.
- When native Goal mode is active and the deterministic Loop becomes genuinely blocked, mark the Goal blocked with the same evidence-backed reason.
- Leave the business repository ready for member review. The member decides all Git operations.
