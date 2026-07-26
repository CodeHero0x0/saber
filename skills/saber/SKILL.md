---
name: saber
description: Route a team member's natural-language development request to the smallest relevant Saber skill.
user-invocable: true
---

# Saber Router

`/saber <自然语言请求>` 是成员处理工作项的默认入口。用中文回复；不要要求成员选择
角色、阶段、工作流命令或 handoff。当前请求、单文件工作项和按需命中的知识条目共同构成当前事实。

成员也可明确选择方法集合：`/saber-superpower`、`/saber-openspec`、`/saber-grill` 与
`/saber-grill-with-docs`。这些入口只限制本轮优先采用的方法，不能创建第二套正式产物。

## 读取最少上下文

1. 从输入识别已有 Jira Key 或 `workitems/<ID>.md`。已存在时读取该单一 Markdown 文件；缺失时
   如实指出，不补造历史。新需求以 Jira Key 或可读标题创建一个 Markdown 文件。
2. 从请求涉及的业务仓、模块、主题或知识 ID 执行 `saber knowledge resolve`。先读取命中的业务仓
   客户规则，再读取 `project-knowledge/` 的直接命中条目及最多一跳依赖，最后补充少量
   `team-contracts/` 团队实践；不得全量读取知识正文。
3. 向用户说明命中路径、理由、风险和未覆盖范围。命令报告来源过期或 AI 发现客户规则冲突时暂停，
   由用户决定更新知识还是更新代码；普通检索不写入工作项。
4. 仅在范围、验收、安全边界、知识冲突或外部写入授权会改变结果时提出一个最小问题。

## 意图路由

每轮选择一个主技能；必要时再附加验证技能。先说明“工作项、理解到的意图、选中的技能、
证据缺口和下一步”，再执行该技能的当前合同。

| 用户意图或信号 | 主技能 | 记录位置 |
| --- | --- | --- |
| 新需求、范围、验收、架构方向仍不明确 | `openspec` explore/propose 或 Superpowers brainstorming | 工作项正文的范围/验收 |
| 已确认的设计、拆解、依赖、跨仓顺序 | Superpowers writing-plans | 工作项正文的设计/依赖 |
| 明确要求实现、改代码、执行已批准计划 | Superpowers executing-plans | 工作项正文的实施/验证 |
| 失败测试、错误、回归、缺陷 | Superpowers systematic-debugging | 工作项正文的验证/风险 |
| 测试、验证、完成前检查 | Superpowers verification-before-completion | 工作项正文的验证/交付 |
| 评审已完成实现或方案 | Superpowers requesting-code-review | 工作项正文的验证/风险 |
| 要求质疑需求、方案、边界或风险 | Grill Me | 工作项正文的设计/风险 |
| 要用权威资料验证技术主张 | Grill With Docs | 工作项正文的设计/验证 |

不要把上表理解为固定流程。用户可以在同一工作项中直接提出澄清、计划、实现、修复或验证；
每次均按当前自然语言重新路由。

## 工作项记录

- `workitems/<ID>.md` 的 YAML front matter 保存经 Zod 校验的仓库、真实依赖、决策、风险与
  `knowledgeImpact`；正文保存输入、范围、验收、设计、实施、验证与交付。
- 不得写入 `stage`、`role`、`nextStep`、`allowedAction` 或任何自动推进字段。
- 语义改动涉及模块、接口、数据模型或业务行为时，在 `knowledgeImpact` 写入更新、核验无需更新，
  或等待用户决策的结论；普通知识检索不保存上下文清单。
- 不保存完整聊天、大段日志、凭证或业务仓源码；只保存可复查的摘要和引用。

## 安全

- 只读操作可直接执行。HTTP、Git 等 L2 外部写入必须先运行 `saber action preview`，展示
  预览并等待用户给出该预览的精确确认 token。L3 禁止。
- 原生 MCP 由当前 AI 工具运行；Saber 只通过 `init/materialize` 安装或通过 `uninstall`
  删除 Saber-owned 配置。
- `/saber` 不因路由到任何技能而获得额外授权。
