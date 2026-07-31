# Saber

Saber 是团队共享的 AI Skill 与知识资产仓，不是开发流程框架、MCP 管理器或 AI 路由器。

业务代码始终位于 `projects/<name>` 下的独立 Git 仓。成员从各自业务仓打开 AI；Saber 只分发团队选定的 Skill，提供只读团队知识，并让成员在人工 review 前把可复用结论归档为本地 Saber commit。

## Setup

从 Saber 根仓运行：

```bash
saber setup
```

setup 会从 `mattpocock/skills` 的 `main` 直接更新 `saber.yaml` 选择的 Skill，将它们缓存在本机 Saber 根仓，并向已存在的 Codex、Claude Code、OpenCode 项目级 Skill 目录创建软链接。它不会配置 MCP、凭据、tracker、AI 工具设置或 Git remote。

同名的成员 Skill 永不覆盖；不存在的项目或工具目录只会被报告跳过。

## 日常使用

在 `projects/frontend` 或 `projects/backend` 打开 AI，直接使用团队 Skill，例如：

```text
/grill-me
/grill-with-docs
/to-spec 只生成草稿，不发布
/to-tickets 只输出拆分，不发布
/implement
/team-knowledge
/promote
```

没有 tracker 配置时，upstream Skill 的 tracker 发布能力不属于 Saber 支持范围。

详细 spec、design、plan、术语和 ADR 默认保存在业务仓的本地工作区，不随业务仓提交。只有成员显式调用 `/promote` 时，AI 才会在 Saber 本地 `promote/<slug>` 分支写入经过摘要的 Requirement、Architecture 或 Knowledge 更新，并创建一个本地 commit。AI 不会 push、pull、fetch 或 merge。

## 团队资产

- `requirements/`：跨仓或长期业务需求。
- `architecture/`：系统边界、跨仓契约和长期架构决策。
- `knowledge/`：按项目或共享范围维护的当前、可验证事实。
- `skills/`：Saber 自有的 `team-knowledge` 与 `promote` Skill。

`/team-knowledge` 按需读取最多一份 Requirement、一份 Architecture 和三张 Knowledge 卡，并说明命中理由和缺口；它不做 Git 操作、知识图谱或全量上下文注入。
