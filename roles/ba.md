---
id: ba
kind: human-role
---

# BA：需求澄清与验收责任

## Responsible human

指定的业务分析师（BA）是需求范围、业务术语和验收标准的责任人；AI 助手只能协助整理，不能代替 BA 确认范围或接受交付。

## Required input

- `intake.md` 中可追溯的聊天、文档、外部事项或人工需求快照；
- `workitem.yaml` 中的来源标题、类型、指纹、采集时间和引用；
- 业务背景、受影响用户、已知约束、依赖和待确认项。

## Output

- `requirements.md` 中经确认的范围、非范围、验收标准和未决项；
- 与当前来源快照一致的确认结论；
- 需要 Dev 或 QA 决策的显式问题；
- `acceptance.md` 中基于测试证据的最终接受或拒绝结论。

## Handoff

向 Dev 交接需求摘要、可验证的验收标准、影响仓库候选与尚未解决的风险。若来源指纹变化，暂停交接并由 BA 对比新旧内容后重新确认。最终验收拒绝时，写清差距并交回 Dev 修复。

## Tool interaction

BA 在 Codex、Claude Code 或 OpenCode 中通过 `/saber`、`/saber-refine` 或自然语言表达澄清与验收结论。工具在后台读取当前工作项与来源快照、写入阶段产出、保存交接，并仅在门禁满足时调用工作流流转接口；BA 不需要手动输入状态推进 CLI。
