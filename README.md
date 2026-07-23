# Saber

Saber 是团队共同维护的 AI 开发资产仓库。团队成员克隆后，只需为自己使用的 AI 工具执行一次初始化，即可获得统一的 `/saber` 命令，并根据对话和工作项状态完成需求、设计、开发、测试、修复与验收。

Saber 不要求成员选择 BA、Dev 或 QA 身份。阶段名称只表达当前事项的关注点，不构成角色交接或权限边界。`projects/` 下的业务仓库保持独立 Git 历史。

## 初始化

要求 Node.js 20+、Git 和至少一个 Codex、Claude Code 或 OpenCode。

```bash
git clone https://github.com/CodeHero0x0/saber.git
cd saber
npm ci
npm run build
cp .env.example .env

npm run saber -- validate --json
npm run saber -- init --tool codex
```

可将 `codex` 替换为 `claude` 或 `opencode`。`init` 会在缺失时创建 `saber.local.yaml`、更新团队外部技能资产，并为所选工具安装统一 `/saber` 命令和团队 MCP 原生配置。

## 使用

在 AI 工具中直接输入：

```text
/saber 把这段需求整理成可验收的工作项
/saber <KEY> 继续实现当前事项
/saber <KEY> 验证边界场景并修复失败项
```

`/saber` 先读取工作项事实，再根据对话决定当前要做的阶段。用户不需要操作状态机命令，也不需要进行角色 handoff。

每个工作项只保留最小交付包：`workitem.yaml`、`intake.md`、`requirements.md`、`design.md`、`plan.md`、`tests.md`、`repositories.yaml`。阶段变化记录在 `workitem.yaml.workflow.history`。

## MCP 边界

Saber 只管理团队 MCP 配置的安装与卸载，不提供 MCP runtime，不启动 server，不代理 tool call。MCP 由 Codex、Claude Code 或 OpenCode 原生运行。

原生 MCP 只允许映射 L0/L1 capability。L2 外部写入不能通过原生 MCP 暴露，必须使用 Saber 的受控 connector，先 preview 再使用精确确认 token；L3 始终禁止。

团队在 `saber.yaml` 声明 server 启动参数、URL 和环境变量名；真实凭证只存在本地环境中。`init/materialize` 将声明写入所选 AI 工具的原生配置，`uninstall` 只删除 Saber-owned 配置项。

```bash
npm run saber -- materialize --tool claude --project backend
npm run saber -- uninstall --tool codex
npm run saber -- uninstall --all
npm run saber -- uninstall --all --apply --confirm <preview-token>
```

HTTP、Git 等 Saber 自身执行的 L2 外部写入仍必须先 `action preview`，再使用精确确认 token；L3 禁止。

## 管理与验证

```bash
npm run saber -- doctor --json
npm run saber -- external update
npm run saber -- external update --apply --confirm <preview-token>
npm test
npm run check
npm run build
git diff --check
```

`saber.yaml` 是团队事实来源；`saber.local.yaml` 和 `.env` 是个人本地配置，不得提交。
