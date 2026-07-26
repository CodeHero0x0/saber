---
name: grill-with-docs
description: Use when a plan or technical decision must be challenged against authoritative documentation with traceable citations.
user-invocable: true
---

# Grill a plan with cited documentation

1. Define the claims that need evidence and identify the authoritative source for each claim (official product docs, a standards body, or a maintained project specification).
2. Read the relevant primary documentation before drawing conclusions; distinguish documented behavior from inference.
3. Cite each material finding with title, URL, section or anchor, and retrieval date. Quote only the minimum text needed to preserve meaning.
4. Challenge the plan against version compatibility, security constraints, operational limits and documented failure behavior.
5. Produce a decision record with supported claims, unresolved gaps, citations, and the person who must decide any trade-off.

Do not treat blog posts, generated text or a search snippet as authority when official documentation is available. If documentation conflicts or is unavailable, mark the claim uncertain and pause for a responsible human.

## Saber 文档草稿交接

`/saber` 在用户要求以权威资料验证技术主张时可路由到本技能。输入为当前
`workitems/<ID>.md`、待验证主张和用户选择的文档。输出需把每条结论回链到标题、URL 或路径、版本
或日期、章节和适用限制，并将冲突与未知项写回该工作项正文的设计、验证或风险部分；不代替用户确认
或授权外部写入。
