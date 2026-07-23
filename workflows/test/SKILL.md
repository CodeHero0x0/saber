---
name: test
description: Use when confirmed acceptance criteria and implementation evidence must become reproducible quality evidence.
---

# Test workflow

## Entry conditions

- A confirmed requirement and implementation evidence are present.
- The changed repository commits and intended test environments are identified.
- A team member is ready to verify the change.

## Steps

1. Derive test coverage from acceptance criteria, integration boundaries and known risks.
2. Run relevant automated and manual checks; preserve commands and stable evidence references rather than copying long logs.
3. Distinguish passed checks, failed checks, blocked checks and untested risk.
4. Re-check the source fingerprint before making a quality conclusion.
5. On failure, record reproducible evidence; on pass, map every acceptance criterion to evidence.

## Artifacts

- `workitems/<KEY>/tests.md`
- Updated `workitems/<KEY>/repositories.yaml` evidence references

## Gate

QA records a human-owned conclusion: pass, blocked, or fail. A pass requires evidence for every agreed acceptance criterion or a documented approved exception.

The AI tool persists the conclusion through the internal workflow transition interface. QA users report results through `/saber` or natural language and do not manually invoke state progression commands.

## Pause condition

Pause when the test environment is unavailable, the source fingerprint changed, evidence conflicts with expected behavior, or a test result cannot be reproduced. Record the reason and resume in the background only after the responsible QA resolves it.
