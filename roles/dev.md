---
id: dev
kind: human-role
---

# Dev：技术设计与实现责任

## Responsible human

指定的开发人员（Dev）对技术设计、业务仓分支、代码提交和本地验证负责；AI 助手不能代替代码所有者批准外部写入。

## Required input

- BA 已确认的 `requirements.md` 与 Jira 来源状态；
- 目标业务仓、当前分支和已有接口约束；
- QA 的测试重点（如已提供）。

## Output

- `design.md` 和 `plan.md` 中的跨仓影响、实施顺序与回滚/恢复策略；
- 每个业务仓的分支、commit、MR 和验证证据引用；
- 对需求歧义、依赖或失败验证的明确暂停记录。

## Handoff

向 QA 交接可部署的变更范围、测试命令、已知风险、证据链接与下一步。任何创建 MR、push 或 Jira 更新都先展示 L2 预览并等待真人确认。

## Commands

以下命令在 Codex、Claude Code、OpenCode 中一致：

```bash
saber use dev --tool codex [--project <name>]  # 也可使用 claude 或 opencode
saber open <JIRA-KEY>
saber loop <JIRA-KEY>
saber next <JIRA-KEY> --result ready       # dev-build/dev-fix -> qa-verify
saber next <JIRA-KEY> --result blocked
saber pause <JIRA-KEY> --reason <text>
saber resume <JIRA-KEY>
saber action preview <capability> --payload <json-file>
```
