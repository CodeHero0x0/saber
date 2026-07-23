# Plan — SABER-20260723-002

## backend (`projects/backend`)

1. 确认目录无独立 `.git`，添加 `.gitignore`（至少忽略 `target/`、`.idea/`、`.DS_Store`）。
2. `git init`，默认分支 `main`，首次 commit。
3. `gh repo create CodeHero0x0/saber-backend-ready --private --source=. --remote=origin --push`。
4. 记录远程 URL、branch、commit 到 `repositories.yaml`。
5. 用 `gh repo view` / 远程只读检查确认 private 与默认分支。

## Verification

- `gh repo view CodeHero0x0/saber-backend-ready --json name,visibility,url`
- 本地 `git status` / `git remote -v` / `git log -1`
