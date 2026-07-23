# 测试与验证证据 — SABER-20260723-002

## 验收标准对照

| 验收标准 | 结果 | 证据 |
| --- | --- | --- |
| GitHub 存在私有仓库 `CodeHero0x0/saber-backend-ready` | 通过 | `gh repo view`：`visibility=PRIVATE`，URL `https://github.com/CodeHero0x0/saber-backend-ready` |
| 克隆/推送内容含就绪探测源码与 README | 通过 | 首 commit `dbaec18` 含 `pom.xml`、`src/**`、`README.md`、`.gitignore`；`main` 已跟踪 `origin/main` |

## 本地检查

| 检查 | 命令/操作 | 结果 | 角色/时间 |
| --- | --- | --- | --- |
| 独立 Git 初始化 | `git init -b main` + 首次 commit | 成功，`dbaec181ba325fc5d6cdf4871722550e81a0c7f2` | Dev 2026-07-23 |
| 创建并推送私有仓 | `gh repo create CodeHero0x0/saber-backend-ready --private --source=. --remote=origin --push` | 成功 | Dev 2026-07-23 |
| 远端可见性 | `gh repo view ... --json visibility` | `PRIVATE` | Dev 2026-07-23 |
| 来源指纹 | 推送前未改需求快照 | 仍为 `sha256:0a7bb4cfdcfb0e557e918c0d3d3fe6ca47b3f6971be156d63341b47170b979d6` | Dev 2026-07-23 |

## 已知限制

- 未配置 CI/CD（本期非范围）。
- 未做二次空目录克隆复验；QA 以 `gh repo view` 与远端 tree 只读复核代替。

## QA 复验（2026-07-23）

| 检查 | 结果 |
| --- | --- |
| 来源指纹 drift | `current` |
| `gh repo view` 可见性 | `PRIVATE` |
| 远端 commit tree | 含 `pom.xml`、`src/**`、`README.md`、`.gitignore` |
| 本地与 `origin/main` | 一致（`dbaec18…`） |

## QA 结论

- [x] 人工 QA 于 2026-07-23 确认 **pass**（对话回复）。
- 两条验收标准均有可复核证据；指纹结论前复检为 `current`。
- 已交接 BA 做最终验收。
