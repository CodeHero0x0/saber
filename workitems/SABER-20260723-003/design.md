# Design — SABER-20260723-003

## Cross-repository impact

- 变更落在 **Saber 资产仓**（本仓）：`workitems/` 证据包与流程文档。
- `projects/backend` 无代码变更（工作项仍挂 workspace project `backend` 仅为配置引用）。

## Approach

1. 将已关闭的 `SABER-20260723-001`、`SABER-20260723-002` 整包加入 Saber Git 并推送到 `origin/main`。
2. 在 `AGENTS.md` / `CLAUDE.md` 与 `workflows/requirements/SKILL.md` 增加关闭推送约定。
3. 本工作项 `SABER-20260723-003` 的产物一并纳入同次或紧随提交推送。

## Risks and decisions

- 只提交 `workitems/**` 与约定文档，不添加 `projects/`、`.saber/`、密钥。
- 推送目标分支：`main`（与当前检出一致）。

## Review gate

- 远程可见 `001`/`002`（及本项）证据；文档含关闭推送约定。
