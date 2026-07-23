# Plan — SABER-20260723-001

## Implementation sequence

1. [x] 确认来源指纹与已批准需求（`requirements.md` / BA ready）。
2. [x] 在 `projects/backend` 新建 Spring Boot（Maven）最小工程。
3. [x] TDD：先写 `GET /api/ready` 失败测试，再实现控制器使测试通过。
4. [x] 本地启动并访问接口，记录验证证据到 `tests.md` 与 `repositories.yaml`。

## Dependencies and rollout

- 单仓交付，无跨仓顺序依赖。
- 无迁移、无 feature flag、无生产发布步骤。

## Verification

- [x] `mvn test`：控制器返回精确正文。
- [x] 启动后访问 `http://localhost:8080/api/ready`，正文为 `saber已准备就绪`。
