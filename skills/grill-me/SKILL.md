---
name: grill-me
description: Use when a requirement, architecture, or implementation plan needs a rigorous interview before irreversible work begins.
user-invocable: true
---

# Grill a plan

1. State the decision to be made, the owner, and the smallest useful outcome.
2. Ask one focused question at a time about users, scope, non-goals, dependencies, constraints, evidence, failure modes and acceptance criteria.
3. Treat unverified assumptions as open risks, not facts. Do not invent system access, approvals or test results.
4. Compare alternatives only against the decision criteria already confirmed by the responsible human.
5. End with a concise decision record: chosen approach, rejected alternatives, open questions, risks, and the next human owner.

Use this skill before writing a multi-step plan when uncertainty could change the architecture, ownership, safety boundary or acceptance gate. Pause instead of guessing when an answer would authorize an external write or redefine scope.

## Saber 路由交接

`/saber` 在用户明确要求质疑需求、方案、边界或风险时可路由到本技能。以当前
`workitems/<ID>.md` 与用户输入为依据，只追问会改变目标、范围、验收、风险或责任的问题。结束时将
已确认结论、替代方案与未决风险写回该工作项正文的设计或风险部分；不代替用户确认范围或授权外部写入。
