# 聊天需求快照 - Spring Boot 就绪探测接口

> 来源：Saber 对话确认
> 采集时间：2026-07-23（Asia/Shanghai）

## 确认结论

- 标题：Spring Boot 就绪探测接口
- 目标：本地可启动后端，浏览器访问一个 GET 接口即可看到 `saber已准备就绪`
- 技术栈：Java / Spring Boot
- 范围：在 `projects/backend` 搭建可运行的 Spring Boot 最小服务；提供一个 GET 接口，返回纯文本 `saber已准备就绪`；提供本地启动方式
- 非范围：本期不做前端仓与前端页面；不做鉴权、数据库、CI/CD、Jira/GitLab 联动；不做生产部署
- 验收标准：
  1. 后端能在本地启动
  2. 浏览器访问约定 GET URL，响应正文精确为 `saber已准备就绪`
- 风险：`projects/backend` 当前为 missing，需新建；本机需有 JDK
- 受影响仓库：`backend`（`projects/backend`）；`frontend` 本期不动
- 默认约定：`http://localhost:8080/api/ready`
- 来源类型：chat

## 采集说明

此文件是只读来源快照，用于保留需求确认时的输入。后续澄清结论记录在 `requirements.md`，不要反向改写本快照。
