# 测试与验证证据 — SABER-20260723-001

## 验收标准对照

| 验收标准 | 结果 | 证据 |
| --- | --- | --- |
| 后端能在本地启动成功 | 通过 | QA 阶段 `mvn spring-boot:run` 出现 `Started BackendApplication`；复验后已停止服务 |
| 浏览器/HTTP 访问 `http://localhost:8080/api/ready`，正文精确为 `saber已准备就绪` | 通过 | `curl` 得 `200`、`text/plain;charset=UTF-8`、正文精确匹配 |

## 本地检查

| 检查 | 命令 | 结果 | 角色/时间 |
| --- | --- | --- | --- |
| 单元/接口测试 | `mvn test`（JDK 21） | 通过（`ReadyControllerTest`） | Dev 2026-07-23；QA 复验 2026-07-23 |
| HTTP 验收 | 启动后 `curl http://localhost:8080/api/ready` | `200` + 精确正文 | Dev 与 QA 均复验；服务已停止 |
| 来源指纹 | `saber workitem drift ...` | `current` | QA 结论前复检 |

## 已知限制

- `projects/backend` 尚无独立 Git 远程、MR、CI 记录（`repositories.yaml` 中为 `not-recorded` / null）。
- 未做生产打包与部署验证。

## QA 结论

- [x] 人工 QA 于 2026-07-23 确认 **pass**（对话回复）。
- 两条验收标准均有可复现证据；来源指纹结论前复检为 `current`。
- 已交接 BA 做最终验收。
