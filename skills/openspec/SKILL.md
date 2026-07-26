---
name: openspec
description: "Use when a proposed change needs an explicit, reviewable specification lifecycle: explore, propose, apply, then archive."
---

# OpenSpec change lifecycle

## Explore

Read the current request, `workitems/<ID>.md` when present, and relevant repositories. Capture the problem, affected behavior, constraints, unknowns and evidence without changing implementation.

## Propose

Write a small change proposal with scope, non-goals, acceptance criteria, risks, affected assets and required human approvals. Keep alternatives and unresolved questions explicit.

## Apply

After proposal approval, implement only the accepted scope. Keep the workitem's scope, design, implementation, verification and delivery sections current. Verify the stated acceptance criteria and pause for any L2 external write confirmation.

## Archive

When the change is accepted, preserve the approved proposal, implementation evidence, decisions and follow-up risks in the same workitem. Mark stale proposals superseded rather than rewriting history.

Never skip from exploration to external action. If the user's current input materially changes the requirement, return to Explore or Propose with the responsible human.
