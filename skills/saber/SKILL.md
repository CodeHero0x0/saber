---
name: saber
description: Use when a team member wants to start, continue, inspect, or route Saber work through one tool-native command.
user-invocable: true
---

# Saber 超级命令

`/saber <描述或工作项编号>` 是团队成员唯一主要入口。使用中文回复；先读取已物化的 Saber 上下文和本地工作项，再决定当前阶段，不要求成员记忆内部 CLI。

## 路由顺序

严格按以下优先级选择本轮上下文，命中即停止继续猜测：

1. **用户显式角色或动作**：例如“以 QA 身份验证”或“修复这个缺陷”。显式意图与阶段门禁冲突时，说明冲突并停在门禁前，不能伪造状态转换。
2. **已有工作项状态责任角色**：输入含工作项编号时，读取其状态和证据，使用当前状态的责任角色。
3. **当前物化默认角色**：没有可用工作项责任角色时，把物化角色作为默认上下文。
4. **语义推断**：依据澄清需求、实现/修复、测试/验证等动作推断 BA、Dev 或 QA。
5. **一个最小澄清问题**：仍有多种会改变行为的解释时，一次只问一个最小问题，不执行有歧义的动作。

角色档案只是上下文，不是授权。角色路由不能替真人接受需求、批准验收、声称测试通过、推送代码或批准外部系统变更。具体状态责任和冲突处理见[角色路由参考](references/role-routing.md)。

## 执行契约

1. 输出当前工作项、阶段、责任角色、已知证据、缺口和一个明确下一步。
2. 新需求直接执行 `/saber-intake` 的确认门禁，不要求用户再次输入辅助命令；已有工作项直接读取状态并执行责任角色对应的 `requirements | develop | test | fix` 工作流。
3. 只读操作可直接执行。任何 L2 外部写入都必须先对完全相同的 capability 和 payload 运行 `saber action preview`，向用户展示预览，再等待用户提供该预览的精确 `confirm token`；缺失、失配或过期时停止，不得代替用户确认。
4. L3 在 MVP 中禁止且禁用，不提供绕过方式。
5. 不把凭证、完整聊天、大段日志或业务仓源码写入 Saber；只保存继续工作所需的确认产物与证据引用。
6. MCP 的 L2 capability 必须在配置中唯一解析到一个 server/tool；preview 会脱敏展示 arguments，并将 server、tool、目标、规范化 arguments 和当前 MCP 配置指纹绑定到 confirm token。
7. MCP 的 L0/L1 capability 直接使用已物化的原生 MCP 工具，不得通过 `saber action execute` 绕过普通工具的风险过滤；L2 execute 重新校验配置和 upstream `tools/list`，确认工具存在后只调用一次。
8. MCP 写入完成后优先使用同一 server 上可用的读 capability 做 reconcile；没有可用读工具、读工具失败或结果无法确认时，返回 `uncertain`，说明不要盲目重试并先读取事实来源恢复。

## 后台接口

- 新需求：完成 BA 追问和用户确认后，将确认草稿写入仓库内 Markdown 文件，再调用 `saber workitem create [WORKITEM-KEY] --source-type <chat|jira|document|manual> --source-title <标题> --source-file <文件> --project <项目>`；未给编号时由 Saber 自动生成。
- 已有事项：先调用 `saber workitem status <WORKITEM-KEY> --json` 获取唯一事实状态，再读取当前阶段所需产出；不得只根据聊天猜测状态。
- 阶段结论：真人明确给出 ready、pass、fail、accept、reject 或 blocked 后，先写完整阶段产出和交接，再由后台调用 `saber next`、`saber pause` 或 `saber resume`。BA 门禁必须携带当前来源指纹。
- 状态查看与聚焦不写外部系统；辅助命令是同一执行契约的明确入口，不是另一套工作流。

Jira 只是统一来源模型中的 `source.kind: jira`，不拥有单独的数据路径。以上 CLI 仅供已加载技能在后台调用，不展示成业务用户的操作步骤。
