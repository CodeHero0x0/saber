---
name: superpowers
description: Use when selecting the smallest relevant Superpowers workflow for a Saber workitem without turning every task into a ceremony.
---

# Select a relevant Superpowers workflow

Choose only the workflow that matches the current risk and task shape:

- Use **brainstorming** before a new feature, behavior change, or architecture decision that is not yet approved.
- Use **writing-plans** for a confirmed multi-step change with dependencies or review points.
- Use **test-driven-development** for behavior changes and regressions where a focused failing test can define the contract; use proportional verification for mechanical documentation or catalog edits.
- Use **systematic-debugging** for an unexpected failure: reproduce, isolate, find root cause, then change code.
- Use **requesting-code-review** after a material implementation and **verification-before-completion** before claiming a check passed.
- Use **finishing-a-development-branch** only when the branch is verified and ready to integrate.

Follow the selected workflow's current instructions. A workflow never changes human ownership, bypasses L2 confirmation, or converts an unverified claim into evidence.

## 可复用资产

- 先查[工作流选择路由](references/workflow-routing.md)，按任务形状选择最小且足够的流程。
- 在开始前完成[选择检查清单](checklists/selection-checklist.md)，把风险、负责人和验证命令写进工作项。
