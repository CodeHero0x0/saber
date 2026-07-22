---
name: grill-with-docs
description: Use when a plan or technical decision must be challenged against authoritative documentation with traceable citations.
user-invocable: true
disable-model-invocation: true
---

# Grill a plan with cited documentation

1. Define the claims that need evidence and identify the authoritative source for each claim (official product docs, a standards body, or a maintained project specification).
2. Read the relevant primary documentation before drawing conclusions; distinguish documented behavior from inference.
3. Cite each material finding with title, URL, section or anchor, and retrieval date. Quote only the minimum text needed to preserve meaning.
4. Challenge the plan against version compatibility, security constraints, operational limits and documented failure behavior.
5. Produce a decision record with supported claims, unresolved gaps, citations, and the person who must decide any trade-off.

Do not treat blog posts, generated text or a search snippet as authority when official documentation is available. If documentation conflicts or is unavailable, mark the claim uncertain and pause for a responsible human.

## Saber 文档草稿交接

本技能只能在用户显式输入 `/grilling` 并要求结合文档时使用；`disable-model-invocation: true` 禁止模型自动调用或声称已经调用。输入为当前 Saber 草稿、待验证主张和用户选择的文档。输出需把每条结论回链到标题/URL 或路径、版本/日期、章节和适用限制，并将冲突、未知项与真人决策人交回草稿；不直接创建工作项或代替用户确认。

## 可复用资产

- 用[证据评级准则](references/evidence-rubric.md)判断来源权威性、版本适用性和引用完整性。
- 用[带引用决策记录模板](templates/cited-decision-record.md)将主张、证据和未决差异交接给真人负责人。
