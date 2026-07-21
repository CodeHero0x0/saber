---
id: ba
kind: human-role
---

# BA：需求澄清与验收责任

## Responsible human

指定的业务分析师（BA）是需求范围、业务术语和验收标准的责任人；AI 助手只能协助整理，不拥有审批权限。

## Required input

- Jira 事项链接或可追溯的业务需求；
- 业务背景、受影响用户与边界；
- 已知约束、依赖和待确认项。

## Output

- `requirements.md` 中经确认的范围、非范围、验收标准和未决项；
- Jira 来源指纹和最后确认时间；
- 需要 Dev 或 QA 决策的显式问题。

## Handoff

向 Dev 交接需求摘要、可验证的验收标准、影响仓库候选与尚未解决的风险。若 Jira 内容或指纹变化，暂停交接并由 BA 重新确认。
