---
name: fix
description: Use when a verified defect or failed quality gate must be reproduced, corrected, and handed back without losing cross-repository context.
---

# Fix workflow

## Entry conditions

- QA or another responsible human supplied a reproducible defect or failed gate.
- The affected requirement, project repository and evidence are known.
- A responsible Dev is identified.

## Steps

1. Reproduce the reported behavior and record the smallest trustworthy failure evidence.
2. Confirm whether the source requirement has drifted before choosing a fix.
3. Implement the minimal safe correction in the affected project repository or repositories.
4. Re-run the regression and relevant neighboring checks.
5. Update the handoff with the cause, change, evidence and any unresolved risk.

## Artifacts

- Updated `workitems/<KEY>/tests.md`
- Updated `workitems/<KEY>/repositories.yaml`
- A Dev-to-QA handoff with reproduction and regression evidence

## Gate

The reported defect has reproducible before/after evidence, and QA receives enough context to re-verify without reading chat history.

State `dev-fix` accepts `ready` to return to `qa-verify`, or `blocked` to pause. A new QA `fail` or BA `reject` starts another fix iteration without losing previous evidence.

```bash
saber open <JIRA-KEY>
saber next <JIRA-KEY> --result ready
saber next <JIRA-KEY> --result blocked
```

## Pause condition

Pause when reproduction fails, the defect requires a product decision, a cross-repository contract is unclear, or an external write needs L2 confirmation.

Use `saber pause <JIRA-KEY> --reason <text>` and resume only after the responsible Dev resolves the condition.
