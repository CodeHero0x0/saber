---
name: develop
description: Use when confirmed requirements must be converted into a cross-repository implementation plan and independently reviewable code changes.
---

# Develop workflow

## Entry conditions

- `requirements.md` has a current BA confirmation.
- Target repositories and their current branches are known.
- A responsible Dev is identified.

## Steps

1. Inspect only the relevant project repositories and identify interface and sequencing dependencies.
2. Write the smallest testable design and per-repository plan before modifying code.
3. Implement in each project repository using that repository's normal branch and commit flow.
4. Run relevant local checks and record commands, results and known limitations.
5. Create an explicit preview before any L2 action such as push or MR creation, then wait for human confirmation.

## Artifacts

- `workitems/<KEY>/design.md`
- `workitems/<KEY>/plan.md`
- `workitems/<KEY>/repositories.yaml`
- A Dev-to-QA handoff record with commit and test evidence references

## Gate

Each target repository has a clear owner, branch, implementation evidence and verification plan; cross-repository assumptions are documented.

## Pause condition

Pause when requirements drift, a required repository is missing/dirty in a way that obscures ownership, an interface is undecided, or an L2 confirmation is absent.
