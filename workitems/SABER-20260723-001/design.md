# Design — SABER-20260723-001

## Cross-repository impact

- 仅影响 `backend`（`projects/backend`）。
- 本期无前端、无共享契约仓、无数据存储。

## Interface and data contract

- Method / Path：`GET /api/ready`
- Content-Type：`text/plain;charset=UTF-8`（或等价纯文本）
- Body：精确字符串 `saber已准备就绪`（无 JSON 包装、无前后空白）
- 状态码：`200`
- 兼容性：全新服务，无存量调用方；回滚即停服务即可

## Risks and decisions

- `projects/backend` 原先缺失，本工作项新建独立 Maven/Spring Boot 工程。
- 默认端口 `8080`；路径固定 `/api/ready`（与 `requirements.md` 一致）。
- 不做鉴权与 CORS 扩展（无浏览器前端调用需求）。

## Review gate

- 设计覆盖验收：本地启动 + 浏览器访问 GET 得到精确正文。
