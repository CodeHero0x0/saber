# Design — SABER-20260723-002

## Cross-repository impact

- 仅影响 `backend`（`projects/backend`）。
- 不修改 Saber 框架仓；业务仓保持独立 Git 历史。

## Approach

1. 在 `projects/backend` 初始化独立 Git 仓库（添加 Maven `.gitignore`，排除 `target/`）。
2. 提交现有 Spring Boot 就绪探测源码与 README。
3. 使用 `gh repo create` 创建私有远程 `CodeHero0x0/saber-backend-ready` 并 `git push -u origin main`。

## Interface and data contract

- 无 API 变更；沿用 `SABER-20260723-001` 的 `GET /api/ready` 行为。
- 远程可见性：private。

## Risks and decisions

- 推送依赖本机 `gh` 鉴权与网络。
- 仓库名固定为 `saber-backend-ready`；若远端已存在则停止并回报冲突。

## Review gate

- GitHub 私有仓可访问；克隆内容含源码与 README。
