# Saber

团队共享的 AI 研发脚手架。BA、Dev、QA 在同一套角色、工作流和技能上协作，适配 Codex、Claude Code、OpenCode，并让 `projects/` 下的前后端业务仓保持独立 Git 历史。

## 核心能力

- BA → Dev → QA → Dev 修复/QA 回归 → BA 验收的工作项状态机。
- 团队通用配置 `saber.yaml` 与个人扩展 `saber.local.yaml` 分层管理。
- 按角色和工具物化团队技能、外部技能、workflow 与只读能力。
- 稀疏拉取外部技能包，只保留被团队选择的技能目录。
- Jira、GitLab、Git、MySQL MCP、IdeaMCP 连接器与 L0-L3 安全门禁。
- 多业务仓独立 clone、分支、提交、MR 和测试证据管理。

## 快速上手

要求 Node.js 20+、Git，以及至少一个 AI 编程工具。

```bash
git clone https://github.com/CodeHero0x0/saber.git
cd saber
npm ci
cp .env.example .env
cp saber.local.example.yaml saber.local.yaml

# 按本机环境填写 .env 和 saber.local.yaml 后执行
npm run saber -- setup --apply --confirm
npm run saber -- use ba
npm run saber -- demo
npm run saber -- open DEMO-101
npm run saber -- loop DEMO-101
```

日常检查可省略写入确认，只预览外部技能更新：

```bash
npm run saber -- setup
```

## 角色与工具

```bash
npm run saber -- use ba  --tool codex
npm run saber -- use dev --tool claude --project backend
npm run saber -- use qa  --tool opencode --project frontend
```

`use` 会输出对应工具的启动命令和该角色的常用命令。工具选择优先级为命令行、个人默认值、团队默认值。

## 日常工作流

```bash
# 查看证据与当前责任角色
npm run saber -- open PROJ-123
npm run saber -- loop PROJ-123

# 完成当前阶段；合法结果取决于当前状态
npm run saber -- next PROJ-123 --result ready
npm run saber -- next PROJ-123 --result pass
npm run saber -- next PROJ-123 --result fail
npm run saber -- next PROJ-123 --result accept

# 暂停和恢复
npm run saber -- pause PROJ-123 --reason "等待业务确认"
npm run saber -- resume PROJ-123
```

完整中文示例位于 `examples/mock-project/workitems/DEMO-101/`，包含 BA 需求、Dev 设计与修复、QA 失败与回归、BA 最终验收。

## 配置归属

- `saber.yaml`：团队提交，只声明通用默认值和业务仓。
- `saber.local.yaml`：个人扩展，不提交；可设置默认角色/工具、业务仓地址、本地技能和已有 L0/L1 能力。
- `.env`：个人凭证和 MCP 命令，不提交。
- `roles/`、`workflows/`、`skills/`：团队共同维护的角色、流程和技能包。
- `projects/`：独立业务 Git 仓，不提交到 Saber。

个人配置不能新增团队项目、修改项目路径、请求 L2/L3 能力或削弱团队安全策略。

## 高级命令

```bash
npm run saber -- validate --json
npm run saber -- doctor --json
npm run saber -- status --json
npm run saber -- init --apply --confirm
npm run saber -- external update --apply --confirm
npm run saber -- materialize --role dev --tool codex
npm run saber -- workitem create PROJ-123 --jira-url https://jira.example.test/browse/PROJ-123 --fingerprint sha256:... --project frontend
npm run saber -- action preview jira.update --payload payload.json --json
```

所有 L2 外部写入都必须先 preview，再使用精确确认 token 执行；L3 操作禁止执行。

## 验证

```bash
npm test
npm run check
npm run build
```
