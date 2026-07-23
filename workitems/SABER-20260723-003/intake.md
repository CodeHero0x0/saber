# 聊天需求快照 - 关闭工作项时推送交付材料到 Saber 仓

> 来源：Saber 对话确认
> 采集时间：2026-07-23（Asia/Shanghai）

## 确认结论

- 标题：关闭工作项时将交付材料推送到 Saber 仓
- 目标：工作项进入 `done` 时，将 `workitems/<KEY>/` 证据包提交并推送到 `CodeHero0x0/saber`
- 范围：
  1. 立即提交并推送 `workitems/SABER-20260723-001` 与 `workitems/SABER-20260723-002`
  2. 将“BA `accept`→`done` 时必须把工作项交付材料推到 Saber 远程”写入流程约定（`AGENTS.md` / 相关 workflow）
- 非范围：不推送 `projects/` 业务仓源码；不改已关闭项业务结论
- 验收标准：
  1. GitHub `saber` 仓库可见上述两项目录与产物
  2. 文档中有明确的关闭推送约定
- 风险：推送依赖本机 git/gh 鉴权；勿误提交密钥或业务仓
- 受影响仓库：Saber 本仓
- 来源类型：chat
- 来源引用：`chat/saber-workitem-push-on-close/2026-07-23`

## 采集说明

此文件是只读来源快照，用于保留需求确认时的输入。后续澄清结论记录在 `requirements.md`，不要反向改写本快照。
