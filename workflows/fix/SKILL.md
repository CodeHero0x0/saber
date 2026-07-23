---
name: fix
description: Use when a verified defect or failed quality gate must be reproduced and corrected without losing cross-repository context.
---

# Fix workflow

## Entry conditions

- QA or another responsible human supplied a reproducible defect or failed gate.
- The affected requirement, project repository and evidence are known.
- A team member is ready to diagnose and correct the defect.

## Steps

1. Reproduce the reported behavior and record the smallest trustworthy failure evidence.
2. Confirm whether the source requirement has drifted before choosing a fix.
3. Implement the minimal safe correction in the affected project repository or repositories.
4. Re-run the regression and relevant neighboring checks.
5. Update the plan and test evidence with the cause, change, before/after evidence and unresolved risk.

## Artifacts

- Updated `workitems/<KEY>/plan.md`
- Updated `workitems/<KEY>/tests.md`
- Updated `workitems/<KEY>/repositories.yaml`

## Gate

The reported defect has reproducible before/after evidence, and QA receives enough context to re-verify without reading chat history. Repeated QA failures or BA rejections start another fix iteration without discarding earlier evidence.

The responsible Dev reports ready or blocked through `/saber` or natural language. The AI tool calls the internal transition interface only after recording that conclusion; business users do not operate workflow CLI.

## Pause condition

Pause when reproduction fails, the defect requires a product decision, a cross-repository contract is unclear, or an external write lacks L2 confirmation. L2 actions require an exact confirmation token bound to the visible preview; L3 actions remain forbidden. Resume only after the responsible Dev resolves the condition.
