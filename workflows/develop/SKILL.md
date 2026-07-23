---
name: develop
description: Use when confirmed requirements must be converted into a cross-repository implementation plan and independently reviewable code changes.
---

# Develop workflow

## Entry conditions

- `requirements.md` has a current BA confirmation tied to the current source fingerprint.
- Target repositories and their current branches are known.
- A team member is ready to implement the confirmed requirement.

## Steps

1. Inspect only the relevant project repositories and identify interface and sequencing dependencies.
2. Write the smallest testable design and per-repository plan before modifying code.
3. Implement in each independent project repository using that repository's normal branch and commit flow.
4. Run relevant local checks and record commands, results and known limitations.
5. Update repository and verification evidence so the next action does not depend on chat history.
6. Before any L2 action such as push, MR creation or external-item update, call the preview interface and wait for the exact confirmation token bound to that preview. Never execute L3 actions.

## Artifacts

- `workitems/<KEY>/design.md`
- `workitems/<KEY>/plan.md`
- `workitems/<KEY>/repositories.yaml`

## Gate

Each target repository has a clear owner, branch, implementation evidence and verification plan; cross-repository assumptions are documented. The responsible Dev explicitly records ready or blocked.

The AI tool writes that conclusion through the internal workflow transition interface. Team members request design or implementation through `/saber` or natural language, without invoking state progression CLI.

## Pause condition

Pause when requirements drift, a required repository is missing or dirty in a way that obscures ownership, an interface is undecided, or an L2 confirmation is absent. Record the condition and resume in the background only after the responsible Dev resolves it.
