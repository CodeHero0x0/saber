# Claude Code 的 Saber 运行时指引

从 Saber 根目录启动 Claude Code；Claude Code 从根目录的 `.claude/skills` 发现 Saber。
使用 `/saber`，或明确使用 `/saber-superpower`、`/saber-openspec`、`/saber-grill`、
`/saber-grill-with-docs` 处理工作项。

工作项只使用 `workitems/<ID>.md`。其 YAML front matter 是经 Zod 校验的仓库、依赖、决策、风险
与 `knowledgeImpact` 事实；正文记录输入、范围、设计、验证与交付。不得使用 `stage`、`role` 或
自动推进字段。业务代码位于 `projects/` 下的独立 Git 仓库；不要将业务仓源码、凭证、完整聊天
记录或大段日志写入工作项。

加载上下文时，业务仓客户规则优先于 `project-knowledge/` 的项目知识和 `team-contracts/` 的团队
实践。先运行 `saber knowledge resolve`，仅读取命中路径和最多一跳依赖，并在对话中说明理由、风险
和缺口；普通检索不写入工作项。发现来源过期或规则冲突时暂停，由用户决定更新知识还是更新代码。

只读操作可以直接执行。L2 外部写入必须先运行 `saber action preview`，展示预览并等待用户
提供该预览返回的精确确认 token；该 token 仅适用于对应的能力、请求内容和目标。L3 操作
始终禁止。`/saber` 不增加任何授权。
