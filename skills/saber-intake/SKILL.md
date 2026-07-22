---
name: saber-intake
description: Use when a request must enter Saber as a new, traceable workitem from chat, Jira, a document, or manual input.
user-invocable: true
---

# Saber 需求接入

`/saber-intake <描述>` 强制从 BA 接入开始。全程使用中文，一次只问一个会改变需求的澄清问题，依次确认业务目标、范围与非范围、验收标准、风险、受影响仓库、来源类型和引用。

## 确认门禁

1. 根据回答形成“需求草稿”，包含标题、目标、范围、非范围、验收标准、风险、仓库、`source.kind`、来源引用和未决项。
2. 向用户完整展示草稿并明确询问是否确认。修改意见只更新草稿；用户确认之前不得创建工作项、生成编号或推进状态。
3. 用户确认之后，才允许把确认草稿写入仓库内受控的临时 Markdown 文件，并由后台调用 `saber workitem create [WORKITEM-KEY] --source-type <类型> --source-title <标题> --source-file <文件> --project <项目>` 创建工作项；省略编号时由 Saber 自动生成。
4. 不把短文本或 `--source-text` 传给 CLI/命令行，不保存或落盘完整聊天；工作项只保留经确认的输入快照、简要澄清结论和必要引用。

所有来源共用一套 `source` 模型：`chat | jira | document | manual`。Jira 仅表示 `source.kind: jira`；其他类型不得虚构 Jira 编号。复杂、矛盾或高影响内容可建议用户显式输入 `/grill-me`；需要结合权威文档时使用 `/grill-with-docs`。本技能不能替用户触发两者。

创建成功后只报告工作项编号、`source.kind`、快照/指纹、受影响仓库、当前阶段和下一步；失败时保留草稿供用户修正，不声称已经落盘。
