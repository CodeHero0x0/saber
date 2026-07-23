# 聊天需求快照 - 后端独立推送到 GitHub

> 来源：Saber 对话确认
> 采集时间：2026-07-23（Asia/Shanghai）

## 确认结论

- 标题：将 Spring Boot 就绪探测后端独立推送到 GitHub
- 目标：把 `projects/backend` 建为独立 Git 仓库并推送到 GitHub 私有仓
- 范围：
  - 在 `projects/backend` 初始化独立 Git 仓库
  - 提交源码（排除 `target/` 等构建产物）
  - 创建并推送到 `CodeHero0x0/saber-backend-ready`（**private**）
  - 保留 README 本地启动与验收说明
- 非范围：
  - 不修改 Saber 框架仓内容
  - 不重开或改写 `SABER-20260723-001` 工作流状态
  - 不做 CI/CD、鉴权、前端、生产部署
- 验收标准：
  1. GitHub 上存在私有仓库 `CodeHero0x0/saber-backend-ready`
  2. 克隆后含就绪探测相关源码与 README
- 风险：依赖本机 `gh` 鉴权与网络；远程仓名需未被占用
- 受影响仓库：`backend`（`projects/backend`）
- 关联来源工作项：`SABER-20260723-001`
- 来源类型：chat
- 来源引用：`chat/saber-backend-github-push/2026-07-23`

## 采集说明

此文件是只读来源快照，用于保留需求确认时的输入。后续澄清结论记录在 `requirements.md`，不要反向改写本快照。
