# 需求澄清产出 - SABER-20260723-004

## 输入与批准

- 来源：`intake.md`
- 指纹：`sha256:7a8d3b802ad16aaa874181d4632b58d1846f2909ea9953686bffe41e8fda7ba9`
- 批准提案：`docs/superpowers/specs/2026-07-23-unified-init-and-workflow-design.md`
- 维护者批准：统一入口与无固定角色；允许删除历史工作项且不保留兼容。

## 已确认范围

1. 成员只选择 Codex、Claude Code 或 OpenCode，运行一次 `saber init --tool <tool>`。
2. 三种工具只获得统一 `/saber`，一次物化需求、开发、测试、修复所需资产，不生成角色上下文。
3. 新工作项使用 schema v4，阶段摘要、风险和下一步只保存在 `workflow.history`，不创建 `handoffs/` 或 `decisions/`。
4. 删除历史工作项、demo、旧辅助命令、旧 schema、旧角色物化和 Saber MCP bridge/runtime，不提供迁移或兼容读取。
5. MCP 直接写入三种工具的原生配置；环境变量只保存引用。原生 MCP 仅允许 L0/L1，L2 必须走 Saber connector 的 preview/token，L3 禁止。
6. 保留外部技能更新、项目级物化、安全卸载、来源指纹、仓库证据和受控外部 action。

## 验收标准

1. `init/materialize` 不接受 role 参数，三工具均生成统一 `/saber` 和全部阶段资产。
2. Codex 使用 `env_vars`/`env_http_headers`，Claude 使用 `${VAR}`，OpenCode 使用 `{env:VAR}`，配置中不出现真实凭证。
3. L2/L3 capability 不能通过原生 MCP 暴露；L2 action 仍要求精确且单次使用的确认 token。
4. 新工作项证据包只有七个核心文件，schema v3 被拒绝，history 保存 summary/risk/next。
5. 卸载仅删除 Saber-owned 投影和 MCP 条目，用户配置、业务仓和被篡改目标保持不动。
6. README 给出从克隆、`.env`、初始化到 `/saber` 的真实路径；CLI 实际加载仓库根 `.env`。
7. `npm test`、`npm run check`、`npm run build`、`git diff --check` 全部通过。

## 非范围

- 不恢复旧工作项、demo 或旧命令兼容。
- 不由 Saber 启动、代理或调用 MCP server。
- 不改变 `projects/` 独立 Git 边界，不执行任何未经确认的 L2 外部写入。

## 未决问题

- 无。

## BA 确认

- 已确认，可进入实现。
