# Test evidence — SABER-20260723-004

## Test strategy

- 统一初始化和物化：三工具、项目根、重复物化、生命周期锁、符号链接、Git exclude 失败回滚。
- 安全边界：原生 MCP 只接受 L0/L1；L2 preview/token 绑定载荷、目标和账户；L3 拒绝且输出脱敏。
- 工作项和卸载：schema v4 七文件证据包、完整状态循环、暂停恢复、事务回滚、单次 token、批次回滚和篡改失败关闭。
- Clean break：旧 CLI/role/demo/runtime 不可用，README 与实际入口一致，init 失败不遗留新本地配置。

## Results

| Check | Repository | Command or reference | Result | Evidence |
| --- | --- | --- | --- | --- |
| 定向安全回归 | saber | `npx tsx --test tests/action-safety.test.ts tests/workitem-v4.test.ts tests/uninstall-safety.test.ts tests/cli-clean-break.test.ts tests/materialize-lifecycle.test.ts tests/unified-workflow.test.ts tests/mcp-config.test.ts` | 通过 | 34/34 |
| 完整集成测试 | saber | `npm test` | 通过 | 118/118 |
| 类型检查 | saber | `npm run check` | 通过 | `tsc --noEmit` |
| 构建与 diff 检查 | saber | `npm run build` / `git diff --check` | 通过 | 构建成功且无 whitespace error |
| 配置与依赖审计 | saber | `npm run saber -- validate --json` / `npm audit --omit=dev --audit-level=high` | 通过 | valid=true，0 vulnerabilities |

## Evidence rules

- Keep only concise commands, URLs, artifact IDs, and result summaries.
- Do not copy business code, large CI logs, MR diffs, tokens, or credentials.
