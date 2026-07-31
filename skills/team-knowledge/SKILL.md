---
name: team-knowledge
description: Read the smallest relevant set of shared Saber requirements, architecture, and verified knowledge before a non-trivial task in a nested business repository. Use automatically for non-trivial work and when explicitly invoked.
---

# Team Knowledge

Use this Skill from a business repository nested under a Saber root. It is read-only: never run Git commands that change state and never write a team asset.

1. Find the current business repository and walk upward until finding a Saber root whose configured project list contains the repository under its `projects/` area. If none exists, say that shared Saber knowledge is unavailable and continue with repository-local context only.
2. Infer the current repository name and task terms from the request and code context. Do not load the entire Saber repository.
3. Read only the YAML front matter of candidate Markdown files under the shared requirements, architecture and knowledge areas. Match by repository scope and task subjects.
4. Read the bodies of at most one matching Requirement, one matching Architecture document and three matching Knowledge cards. Prefer the most specific scope and direct subject match.
5. State the selected documents, why each matched, and any missing or ambiguous context. If there is no match, say so plainly.

The only front matter used for selection is:

```yaml
scope: frontend | backend | cross-repo | shared
subjects: [short-domain-terms]
sources:
  - repository: backend
    path: relative/source/path
    revision: optional-commit-or-contract-version
```

Do not create an index, embeddings, a graph, stale/superseded state, dependency state or a local cache. Existing shared content describes the current known state; Saber Git history retains prior versions.
