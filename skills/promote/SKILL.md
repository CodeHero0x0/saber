---
name: promote
description: Summarize verified local work into a focused local Saber promotion commit. Invoke only when a member explicitly asks to promote reusable learning.
disable-model-invocation: true
---

# Promote

Use this Skill only on an explicit member request from a business repository nested under a Saber root.

1. Find the Saber root by walking ancestors. Confirm the current repository is one of its configured projects.
2. Review the current local work artifacts, the relevant code, tests and contracts. Do not copy chat transcripts, raw specs, detailed designs, plans, local CONTEXT files or raw ADRs.
3. Propose a concise summary and classify it as a long-lived cross-repository Requirement, system-level Architecture, or a current evidence-backed Knowledge card. Update the relevant current card when new evidence changes an existing fact; never invent an implementation fact without evidence.
4. Before writing, verify that the Saber repository is on local `main`, has a clean worktree and has no existing `promote/<slug>` branch. If any check fails, stop without writing, switching branches or committing, and tell the member what to resolve manually.
5. Create `promote/<slug>`, write only the selected summary updates, validate their front matter, and stage only those exact files. Create one local commit and stop.

Never run `git fetch`, `git pull`, `git push`, `git merge`, or any Git write in the business repository. Do not alter MCP, tracker or AI-tool configuration. The member reviews the local Saber branch and decides whether to merge, push or delete it.

Use this minimum metadata for a promoted document:

```yaml
---
scope: frontend | backend | cross-repo | shared
subjects: [short-domain-terms]
sources:
  - repository: backend
    path: relative/source/path
    revision: commit-or-contract-version
---
```

The body states the current requirement, architectural decision or verified fact and explains the evidence concisely. Do not write a changelog or a copied implementation plan.
