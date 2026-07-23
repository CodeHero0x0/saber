# Saber 统一初始化与对话驱动工作流

继续完成已批准的 Saber 脚手架减法重构：成员只选择 Codex、Claude Code 或 OpenCode，统一使用 `/saber`，不绑定固定 BA/Dev/QA 身份；所有阶段资产一次物化；MCP 由工具原生运行，Saber 不保留 bridge/runtime；工作项只使用 schema v4 的 workflow history，不创建 handoff。

维护者于 2026-07-23 进一步批准删除历史工作项，不保留旧工作项、旧 CLI、旧 schema、旧角色物化或 MCP runtime 兼容。原生 MCP 仅允许 L0/L1；L2 外部写入继续要求 Saber preview 和精确确认 token，L3 禁止。
