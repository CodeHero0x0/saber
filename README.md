# Saber

团队共享的 AI 研发脚手架。BA、Dev、QA 使用同一套角色、工作流和技能，在一个 Saber 仓库中管理多个独立业务仓，并适配 Codex、Claude Code、OpenCode。

## 核心能力

- 多项目工作区：`projects/` 下嵌套 clone，前后端仓库独立提交、切换分支和创建 MR。
- 角色工作流：BA 需求澄清、Dev 设计开发、QA 测试修复，使用 workitem 包完成跨角色交接。
- 工具适配：按角色将团队技能、外部技能和能力投影到 Codex、Claude、OpenCode。
- 外部技能：从上游 Git 仓库 sparse 拉取选中的技能包，不暴露整个上游仓库。
- 连接器：Jira、GitLab、MySQL MCP、IdeaMCP，凭证只读取本机环境。
- L0-L2 门禁：读取自动执行；外部写入必须 preview、精确确认和写后 reconcile；L3 永久禁止。
- 安全 Git 操作：`git.push` 绑定项目、push URL、分支和 commit，禁止 force push 和跟随标签。
- 诊断与校验：`validate`、`doctor`、`status` 检查资产、工具、连接器和业务仓状态。

## 快速上手

要求 Node.js 20+、Git，以及至少一个 AI 工具。

```bash
git clone https://github.com/CodeHero0x0/saber.git
cd saber
npm ci
cp .env.example .env
$EDITOR .env
set -a
. ./.env
set +a

npm run saber -- validate
npm run saber -- doctor
npm run saber -- init
npm run saber -- init --apply --confirm
```

`init --apply --confirm` 只 clone `saber.yaml` 中配置了 `repository` 且本地缺失的业务仓；不会删除或覆盖已有目录。当前仓库的 `frontend`、`backend` 默认需要成员自行配置 clone 来源。

## 加载角色

先更新团队选择的外部技能，再物化角色入口：

```bash
npm run saber -- external update --apply --confirm
npm run saber -- materialize --tool codex --role dev
codex .
```

其他工具：

```bash
npm run saber -- materialize --tool claude --role qa
claude .

npm run saber -- materialize --tool opencode --role dev
opencode .
```

可加 `--project frontend` 或 `--project backend`，在对应业务仓生成本地入口。入口目录和运行时文件均被忽略，不会污染业务仓提交。

## 常用工作流

```bash
# 创建和交接跨仓 workitem
npm run saber -- workitem create PROJ-123 \
  --jira-url https://jira.example.com/browse/PROJ-123 \
  --fingerprint sha256:... --project frontend --project backend
npm run saber -- workitem handoff PROJ-123 --role ba \
  --summary "范围已确认" --risk "接口兼容性" --next "Dev 完成设计"

# 检查状态和 Jira 漂移
npm run saber -- workitem status PROJ-123
npm run saber -- workitem drift PROJ-123 --fingerprint sha256:...

# L2 外部写入：先预览，再用同一 token 执行
npm run saber -- action preview jira.update --payload payload.json --json
npm run saber -- action execute jira.update --payload payload.json --confirm <preview-token> --json
```

支持的 HTTP 能力：`jira.read`、`jira.update`、`gitlab.mr.read`、`gitlab.mr.create`。业务仓 push payload：

```json
{"project":"backend","remote":"origin","branch":"feature/PROJ-123"}
```

```bash
npm run saber -- action preview git.push --payload git-push.json --json
npm run saber -- action execute git.push --payload git-push.json --confirm <preview-token> --json
```

## 配置文件

- `saber.yaml`：唯一仓库级 YAML 配置，包含工作区、角色、能力、连接器和外部技能选择。
- `.env.example`：环境变量模板。
- `.env`：本机实际值，已被 Git 忽略。

`.env` 中的 Jira、GitLab token、MCP 命令和账号标识都不能提交。Git push 使用本机 Git credential helper 或 SSH agent。

## 目录约定

```text
roles/       # BA、Dev、QA 责任
workflows/   # requirements、develop、test、fix
skills/      # 团队技能包
adapters/    # 工具适配说明
workitems/   # 跨仓研发证据包
projects/    # 被忽略的独立业务仓
```

Saber 根目录的 Git 操作只影响脚手架仓；进入 `projects/<name>` 后，Git 操作只影响对应业务仓。不要将业务代码、缓存、运行时生成物或凭证提交到 Saber。

## 验证

```bash
npm run saber -- validate --json
npm run saber -- doctor --json
npm run saber -- status --json
npm run check
npm test
npm run build
```

设计规格见 [`docs/superpowers/specs/2026-07-21-saber-ai-development-workflow-design.md`](docs/superpowers/specs/2026-07-21-saber-ai-development-workflow-design.md)。
