# Saber 运行时 AI 指引

从 Saber 根目录处理工作项；业务仓位于 `projects/` 下的独立 Git 仓库。使用 `/saber`，或由
成员明确选择 `/saber-superpower`、`/saber-openspec`、`/saber-grill`、
`/saber-grill-with-docs`。先识别已有工作项目录或 Jira Key，读取最少上下文；不要将无关技能、
完整聊天记录或大段日志写入工作项。

每个工作项只有 `workitems/<ID>.md`：YAML front matter 保存仓库、真实依赖、决策、风险和
`knowledgeImpact`，正文保存输入、范围、验收、设计、验证和交付说明。不得写入 `stage`、`role`、
`nextStep` 或任何自动推进字段；工作项只保存可复查的摘要和引用，不保存业务仓源码、凭证、完整
聊天或完整日志。

知识按需分三层：`team-contracts/` 是团队通用实践，`project-knowledge/` 是当前项目的细粒度
业务/设计/依赖知识，业务仓中的客户规则优先。涉及业务仓时，先运行 `saber knowledge resolve`
定位客户规则和项目知识路径；只读取命中条目及最多一跳依赖，并向用户说明命中理由、风险和缺口。
普通检索不写入工作项。知识可能过期或与客户规则冲突时暂停，由用户决定更新知识还是更新代码。

只读操作可以直接执行。任何 L2 外部写入必须先运行 `saber action preview`，展示预览后等待
用户提供该预览返回的精确确认 token；确认 token 仅适用于对应的能力、请求内容和目标。L3
操作始终禁止。`/saber` 只提供请求路由，不增加任何授权。
