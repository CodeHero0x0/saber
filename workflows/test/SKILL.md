---
name: test
description: Use when QA needs to turn confirmed acceptance criteria and a Dev handoff into reproducible quality evidence.
---

# Test workflow

## Entry conditions

- A BA-approved requirement and a Dev handoff are present.
- The changed repository commits and intended test environments are identified.
- A responsible QA is identified.

## Steps

1. Derive test coverage from acceptance criteria, integration boundaries and known risks.
2. Run relevant automated and manual checks; preserve commands and stable evidence references rather than copying long logs.
3. Distinguish passed checks, failed checks, blocked checks and untested risk.
4. Re-check the source fingerprint before making a quality conclusion.
5. On failure, record reproducible evidence and hand off to Dev; on pass, map every acceptance criterion to evidence and hand off to BA.

## Artifacts

- `workitems/<KEY>/tests.md`
- Updated `workitems/<KEY>/repositories.yaml` evidence references
- A QA handoff to Dev or BA

## Gate

QA records a human-owned conclusion: pass, blocked, or fail. A pass requires evidence for every agreed acceptance criterion or a documented approved exception.

The AI tool persists the conclusion through the internal workflow transition interface. QA users report results through `/saber` or natural language and do not manually invoke state progression commands.

## Pause condition

Pause when the test environment is unavailable, the source fingerprint changed, evidence conflicts with expected behavior, or a test result cannot be reproduced. Record the reason and resume in the background only after the responsible QA resolves it.
