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

## Artifacts

- `workitems/<KEY>/tests.md`
- Updated `workitems/<KEY>/repositories.yaml` evidence references
- A QA handoff to Dev or BA

## Gate

QA records a human-owned conclusion: pass, blocked, or fail. A pass requires evidence for every agreed acceptance criterion or a documented approved exception.

## Pause condition

Pause when the test environment is unavailable, the source fingerprint changed, evidence conflicts with the expected behavior, or a test result cannot be reproduced.
