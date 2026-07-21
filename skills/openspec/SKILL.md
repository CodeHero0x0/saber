---
name: openspec
description: Use when a proposed change needs an explicit, reviewable specification lifecycle: explore, propose, apply, then archive.
---

# OpenSpec change lifecycle

## Explore

Read the current specification, related workitems and relevant repositories. Capture the problem, affected behavior, constraints, unknowns and evidence without changing implementation.

## Propose

Write a small change proposal with scope, non-goals, acceptance criteria, risks, affected assets and required human approvals. Keep alternatives and unresolved questions explicit.

## Apply

After proposal approval, implement only the accepted scope. Keep workitem artifacts, tests and repository references current. Verify the stated acceptance criteria and pause for any L2 external write confirmation.

## Archive

When the change is accepted, preserve the approved proposal, implementation evidence, decisions and follow-up risks in the workitem. Mark stale proposals superseded rather than rewriting history.

Never skip from exploration to external action. If a requirement or source fingerprint changes, return to Explore or Propose with the responsible human.

## 可复用资产

- 在 Propose 阶段从[变更提案模板](templates/change-proposal.md)开始，明确范围、门禁和批准人。
- 在 Archive 阶段用[归档记录模板](templates/archive-record.md)保留证据、偏差和后续事项。
- 在每个阶段对照[生命周期检查清单](checklists/lifecycle-checklist.md)，发生来源漂移时返回 Explore 或 Propose。
