# Plan — SABER-20260723-004

## Implementation sequence

1. [x] 固化 clean-break 范围并创建 schema v4 工作项。
2. [x] 完成统一 init/materialize、三工具原生 MCP 和 lifecycle lock。
3. [x] 删除历史工作项、旧 demo/命令/文档和 MCP runtime。
4. [x] 完成 schema v4 workflow history 与受控 L2 action 边界。
5. [x] 补齐 materialize/uninstall/workitem/action/CLI 定向回归。
6. [x] 更新 README、示例、设计与运行态说明。
7. [x] 执行完整 test/check/build/diff 验证并记录证据。

## Dependencies and rollout

- Node.js 20+、Git、目标 AI 工具。
- 外部技能更新保持现有 Git 资产机制；本轮不执行远程写入。
- 旧安装不迁移，建议从干净 clone 执行新 `init`。

## Verification

- 定向：原生 MCP 字段、L2 拒绝、重复物化、所有权冲突、卸载 token/回滚、workitem v4 门禁。
- 集成：`npm test`、`npm run check`、`npm run build`、`git diff --check`。
- 人工：三工具生成路径与 README 命令一致，历史目录和 runtime 源码不存在。
