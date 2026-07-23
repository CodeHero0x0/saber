---
name: saber
description: Use when a team member wants to start or continue Saber work through one tool-native command.
user-invocable: true
---

# Saber

`/saber <需求描述或工作项编号>` 是唯一工作入口。使用中文回复，先理解对话，再根据工作项事实决定本轮要做的事情。不要询问或假设当前成员是 BA、Dev 或 QA。

## 路由

1. 输入包含工作项编号时，先运行 `saber workitem status <KEY> --json`，读取当前状态、产物和仓库证据。
2. 输入是新需求时，在对话中补齐会改变范围或验收结果的关键信息；内容足够后创建工作项。
3. 根据对话意图和当前事实执行需求澄清、设计、实现、验证、修复或验收。状态只表示事项进度，不限制团队成员能做哪个阶段。
4. 用户明确要求查看、实现、测试、修复或继续时，直接进入该事项；只有缺少一个会改变结果的关键输入时才提一个最小问题。
5. 不要求用户调用内部状态命令，也不制造角色交接仪式。

## 工作契约

- 每轮给出当前工作项、阶段、已有证据、缺口和下一步。没有工作项时先形成可追踪的需求输入。
- 新需求确认后，把原始输入保存为临时 Markdown，再调用 `saber workitem create [KEY] --source-type <chat|jira|document|manual> --source-title <标题> --source-file <文件> --project <项目>`。未给编号时由 Saber 生成。
- 阶段完成后更新对应产物，并在后台调用 `saber workitem advance <KEY> --result <结果> --summary <摘要> --risk <风险> --next <下一步>`；暂停和恢复分别使用 `saber workitem pause`、`saber workitem resume`。
- `workitem.yaml` 的 workflow history 是唯一阶段记录。不要创建 `handoffs/` 或按角色分拆聊天记录。
- 只读操作可直接执行。HTTP、Git 等 L2 外部写入必须先运行 `saber action preview`，展示预览并等待用户提供精确确认 token；L3 禁止。
- MCP 由当前 AI 工具原生运行。Saber 只通过 `init/materialize` 安装或通过 `uninstall` 删除 Saber-owned MCP 配置，不代理、启动或调用 MCP server。
- 不把凭证、完整聊天、大段日志或业务仓源码写入 Saber，只保存确认产物与可复查证据引用。

阶段名称中的 BA、Dev、QA 仅说明该阶段关注点，不表示当前使用者身份，也不构成权限边界。
