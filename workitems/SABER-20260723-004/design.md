# Design — SABER-20260723-004

## Architecture

- `saber init` 负责创建本地配置、更新外部技能并调用统一 `materialize`。
- `materialize` 聚合全部阶段的 team skills、external skills 和 workflows，为目标工具创建 Saber-owned 符号链接及 schema v4 runtime manifest。
- MCP 配置由 Codex TOML、Claude `.mcp.json`、OpenCode JSONC 适配器直接写入；manifest 保存所有权摘要，`uninstall` 用随机单次 token 精确移除。
- 工作项状态机继续保留 BA/Dev/QA 阶段语义，但阶段不绑定成员身份；schema v4 history 是唯一阶段记录。

## Clean break

- 删除旧辅助命令、demo、handoff/decision 模板、MCP bridge/client/runtime、旧工作项和历史设计草案。
- 旧 workitem schema 和旧 materialize manifest 不迁移；新安装从干净 clone/init 开始。

## Security boundaries

- 物化和卸载共享 repository lifecycle lock，拒绝并发写入、符号链接父路径和所有权漂移。
- 原生 MCP 只允许 L0/L1；L2 只使用受控 HTTP/Git connector 的 preview/token 流程。
- 工具配置只写环境变量引用，绝不解析或复制 `.env` 中的凭证值。
- `projects/` 仍是独立 Git 仓库，Saber 只记录稳定证据引用。

## Recovery

- 物化失败恢复旧投影、工具配置和 manifest。
- 卸载失败恢复完整批次；token 与当前目标指纹绑定且只能消费一次。
- 本次 clean break 可通过 Git 历史恢复旧实现，但运行时不提供兼容路径。

## Review gate

- 功能、定向回归和最终四项验证全部通过后进入 QA。
