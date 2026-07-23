---
id: ba
kind: human-role
---

# BA 阶段：需求澄清与验收关注点

## Responsible human

本档案描述需求澄清和验收阶段的关注点，不要求当前成员具有 BA 身份。AI 助手只能协助整理，不能代替真人确认范围或接受交付。

## Required input

- `intake.md` 中可追溯的聊天、文档、外部事项或人工需求快照；
- `workitem.yaml` 中的来源标题、类型、指纹、采集时间和引用；
- 业务背景、受影响用户、已知约束、依赖和待确认项。

## Output

- `requirements.md` 中经确认的范围、非范围、验收标准和未决项；
- 与当前来源快照一致的确认结论；
- 需要 Dev 或 QA 决策的显式问题；
- `requirements.md` 或 workflow history 中基于测试证据的最终接受或拒绝结论。

## Continuity

在核心产物中保留需求摘要、可验证的验收标准、影响仓库候选与尚未解决的风险。若来源指纹变化，暂停推进并由真人对比新旧内容后重新确认。最终 `accept` 进入 `done` 后，须将 `workitems/<KEY>/` 交付材料提交并推送到 Saber 远程（不含 `projects/` 业务源码）。

## Tool interaction

任何成员都通过 `/saber` 或自然语言表达澄清与验收事项。工具在后台读取工作项与来源快照、写入阶段产出，并仅在门禁满足时调用工作流流转接口。
