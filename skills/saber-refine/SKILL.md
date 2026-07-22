---
name: saber-refine
description: Use when a current Saber requirement draft needs deeper clarification or comparison against selected documents.
user-invocable: true
---

# Saber 深化草稿

`/saber-refine` 只深化当前尚未确认的需求草稿。可读取用户明确选择的项目文档、规范或权威资料，区分文档事实、推断、冲突和未决项，并把标题/路径、版本或日期、章节及适用限制写回草稿引用。

一次只问一个会改变范围、验收或风险的问题；随后展示修订前后的关键差异，继续等待用户确认。本命令不创建工作项、不推进状态、不替真人接受需求。

复杂、矛盾或高影响需求可以建议用户显式输入 `/grill-me`；需要依据权威文档追问时输入 `/grill-with-docs`。两个 Grill 技能均为 `disable-model-invocation: true`，因此模型不得代替用户调用；只有用户显式调用后，才能把追问结论及其文档引用汇入 Saber 草稿。不得声称已自动运行 Grill。
