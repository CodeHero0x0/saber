# Artifact contracts

Shared member artifacts live under `specs/<requirement-id>/<member-id>/`.

## DECISIONS.md

Record only decisions needed to interpret the frozen evidence. For each decision include the question, accepted answer, rationale, and affected acceptance criteria.

## SPEC.md

Use these headings:

- Evidence
- Problem statement
- Outcome
- Constraints
- Acceptance criteria
- Implementation decisions
- Testing decisions
- Out of scope

Evidence must include the source path, source commit, and content digest printed by `loop-state.mjs start`.

## TICKETS.md

For each ticket include its stable id, title, blockers, delivered behavior, and acceptance criteria. Do not duplicate the complete Spec or update runtime status in this approved artifact.

## RESULT.md

Prepare after verification and both reviews, immediately before requesting deterministic completion. Summarize delivered acceptance criteria, verification commands and results, review outcomes, remaining non-blocking notes, and changed business-repository files.

Runtime state belongs under `.saber/work/` and must never be copied into shared artifacts or committed.
