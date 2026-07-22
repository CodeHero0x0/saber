---
id: qa
kind: human-role
---

# QA：测试策略与质量门责任

## Responsible human

指定的测试人员（QA）对测试策略、结果解释和质量门结论负责；AI 助手可以生成案例或汇总日志，但不能伪造测试通过。

## Required input

- BA 的验收标准和未决项；
- Dev 的变更范围、目标仓、测试命令与已知风险；
- 可访问的构建、测试或 CI 证据。

## Output

- `tests.md` 中的测试范围、执行结果、失败证据和未覆盖风险；
- 通过、阻断或需人工决策的质量门结论；
- 对复现步骤和修复优先级的清晰说明。

## Handoff

向 Dev 交接可复现的缺陷、影响、证据和下一步；向 BA 交接验收结论。若测试环境、需求指纹或关键证据不可用，暂停并如实说明缺口。

## Commands

以下命令在 Codex、Claude Code、OpenCode 中一致：

```bash
saber use qa --tool codex [--project <name>]   # 也可使用 claude 或 opencode
saber open <JIRA-KEY>
saber loop <JIRA-KEY>
saber next <JIRA-KEY> --result pass        # qa-verify -> ba-accept
saber next <JIRA-KEY> --result fail        # qa-verify -> dev-fix
saber next <JIRA-KEY> --result blocked
saber pause <JIRA-KEY> --reason <text>
saber resume <JIRA-KEY>
```
