---
name: grill-me
description: Use when a requirement, architecture, or implementation plan needs a rigorous interview before irreversible work begins.
user-invocable: true
disable-model-invocation: true
---

# Grill a plan

1. State the decision to be made, the owner, and the smallest useful outcome.
2. Ask one focused question at a time about users, scope, non-goals, dependencies, constraints, evidence, failure modes and acceptance criteria.
3. Treat unverified assumptions as open risks, not facts. Do not invent system access, approvals or test results.
4. Compare alternatives only against the decision criteria already confirmed by the responsible human.
5. End with a concise decision record: chosen approach, rejected alternatives, open questions, risks, and the next human owner.

Use this skill before writing a multi-step plan when uncertainty could change the architecture, ownership, safety boundary or acceptance gate. Pause instead of guessing when an answer would authorize an external write or redefine scope.

## Saber 草稿交接

本技能只能由用户显式输入 `/grill-me` 触发；`disable-model-invocation: true` 禁止模型自动调用或声称已经调用。以当前 Saber 需求草稿、未决项和已选上下文为输入，只追问会改变目标、范围、验收、风险或责任的问题。结束时将已确认结论、仍未决的风险和真人责任人作为结构化摘要交回草稿；不直接创建工作项或代替用户确认草稿。

## 可复用资产

- 用[计划追问问题库](references/question-bank.md)选择与当前不确定性相关的问题，不把问题清单当成机械问卷。
- 将已确认的结论、替代方案和风险写入[决策记录模板](templates/decision-record.md)，再交给下一位责任人。
