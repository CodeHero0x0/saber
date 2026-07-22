# Saber

Saber 是团队共同维护的 AI 研发脚手架。它把 BA、Dev、QA 的责任、工作流、技能包、外部连接能力和多项目工作区放在一个 Git 仓库中；业务项目仍然是 `projects/` 下彼此独立的 Git 仓库。

Saber 的核心原则是：共享语义，工具适配；读取自动，外部写入预览后确认；外部技能手动更新，按角色按需加载。

## 快速开始

需要 Node.js 20+、Git，以及至少一个本地工具（Codex、Claude Code 或 OpenCode）。

```bash
git clone https://github.com/CodeHero0x0/saber.git
cd saber
npm ci
npm run saber -- validate
npm run saber -- doctor
npm run saber -- init
npm run saber -- init --apply --confirm
```

`init` 默认只显示 clone 计划。只有同时提供 `--apply --confirm` 才会 clone `saber.yaml` 中配置了 `repository` 的缺失业务仓；已有目录不会被重新 clone、删除或覆盖。也可以直接进入 `projects/` 按团队规则 clone，业务仓不使用 submodule。

## 工作区和 Git 边界

```text
saber/                         # 团队资产仓
├── saber.yaml                 # 唯一仓库级 YAML 配置
├── roles/                     # BA、Dev、QA 真人责任
├── workflows/                 # requirements、develop、test、fix
├── skills/                    # 团队技能包
├── adapters/                  # 工具适配说明
├── workitems/                 # 跨仓研发证据包
└── projects/                  # 被父仓忽略的独立业务仓
    ├── frontend/.git
    └── backend/.git
```

在 Saber 根目录执行的 Git 命令只影响 Saber；在 `projects/frontend` 或 `projects/backend` 内执行的命令只影响对应业务仓。业务代码、token、账号、私密 URL、CI 日志和 MR diff 都不能提交到 Saber。

## 配置

所有仓库级 YAML 配置都在 [saber.yaml](./saber.yaml)，每个区块和关键字段带有中文说明。

### 工作区和角色

`workspace.tools` 声明默认和支持的工具；`workspace.projects` 声明本地业务仓路径、可选 clone 地址和项目能力。`roleProfiles` 把 `ba`、`dev`、`qa` 关联到：

- `teamSkills`：`skills/` 下的团队技能包；
- `externalSkills`：外部 manifest 中的稳定 ID，例如 `superpowers/writing-plans`；
- `workflows`：`workflows/` 下的流程包；
- `capabilities`：语义能力和风险级别。

角色是默认上下文和人工责任，不是权限。`jira.update`、`gitlab.mr.create` 等写能力仍由 L2 预览确认控制。

### Jira 和 GitLab

仓库只保存环境变量名称，不保存值。实际使用时在本机配置：

```bash
export JIRA_BASE_URL="https://jira.example.com"
export JIRA_ACCOUNT_ID="your-visible-account@example.com"
export JIRA_API_TOKEN="<stored-in-your-shell-or-keychain>"
export GITLAB_BASE_URL="https://gitlab.example.com"
export GITLAB_ACCOUNT_ID="your-visible-account@example.com"
export GITLAB_API_TOKEN="<stored-in-your-shell-or-keychain>"
export GIT_PUSH_ACCOUNT_ID="your-visible-git-account@example.com"
```

Saber 支持：

- `jira.read`：读取 `/rest/api/3/issue/{key}`；
- `jira.update`：通过 L2 预览后更新 Jira issue；
- `gitlab.mr.read`：读取指定 merge request，或按 `project`、`sourceBranch`、`targetBranch` 查询已存在的 MR；
- `gitlab.mr.create`：通过 L2 预览后创建 MR。
- `git.push`：对 `saber.yaml` 中的业务仓执行普通分支 push，并核对远端 commit；实际凭证由本机 Git credential helper 或 SSH agent 管理。

读取和写入结果会以脱敏后的 `data` 返回。Jira/GitLab 写入后会立即只读查询事实源；写请求结果不确定或 reconcile 失败时会暂停并禁止盲目重试。GitLab 创建遇到 409 时会提示使用源分支查询恢复已有 MR。

HTTP token 只在执行阶段读取。预览会显示 `*_ACCOUNT_ID` 指定的非敏感账号身份，并把账号、服务目标和精确变更共同绑定到 confirmation token；执行前更换账号或目标会要求重新预览。输出不会显示 token 或完整服务地址。

### MySQL MCP 和 IdeaMCP

这两个连接器使用本机命令，由工具或团队 MCP 配置提供实际实现：

```bash
export MYSQL_MCP_COMMAND="<your-mysql-mcp-command>"
export IDEA_MCP_COMMAND="<your-ideamcp-command>"
```

`mysql.read`、`idea.project.read` 是只读能力；`mysql.write`、`idea.command.execute` 在 MVP 中仍是 L2。MCP 不可用时 workflow 必须暂停或降级为人工步骤，不能伪造成功。

## 按角色加载到工具

外部下载和工具加载是两个明确步骤：

```bash
# 只下载 saber.yaml 选择的完整外部技能包
npm run saber -- external update --apply --confirm

# 在 Saber 根目录为跨仓工作流加载 Dev 到 Codex
npm run saber -- materialize --tool codex --role dev
codex .

# 在某个业务仓内生成本地、可清理的 QA 入口
npm run saber -- materialize --tool claude --role qa --project frontend
cd projects/frontend
claude .

# OpenCode 使用同一套角色语义
npm run saber -- materialize --tool opencode --role dev --project backend
```

不指定 `--tool` 时使用 `workspace.tools.default`。可以重复 `--capability` 缩小或扩展本次角色上下文中的能力集合：

```bash
npm run saber -- materialize --role dev --capability jira.read --capability gitlab.mr.read
```

Codex 的发现目录是 `.agents/skills/`，Claude Code 是 `.claude/skills/`，OpenCode 由 `adapters/opencode/opencode.json` 声明为 `.opencode/skills/`。每个入口指向完整技能目录，因此模板、引用资料和脚本不会丢失。

生成物位于被忽略的 `.saber/runtime/` 和带 `saber--` 前缀的本地技能入口。`materialize` 只删除自己 manifest 中登记的链接，不会覆盖成员手工安装的技能。项目模式还会写入业务仓 `.git/info/exclude`，不修改业务仓的已跟踪文件。

## 工作项生命周期

```bash
# 创建跨仓证据包
npm run saber -- workitem create PROJ-123 \
  --jira-url https://jira.example.com/browse/PROJ-123 \
  --fingerprint sha256:abc \
  --updated-at 2026-07-22T08:30:00Z \
  --project frontend --project backend

# 角色交接；已知当前指纹时增加漂移门禁
npm run saber -- workitem handoff PROJ-123 --role ba \
  --summary "范围和验收标准已确认" --risk "接口兼容性" --next "Dev 完成跨仓设计" \
  --fingerprint sha256:abc

npm run saber -- workitem status PROJ-123
npm run saber -- workitem drift PROJ-123 --fingerprint sha256:def
```

工作项目录包含 `workitem.yaml`、`requirements.md`、`design.md`、`plan.md`、`tests.md`、`repositories.yaml`、追加式 `handoffs/` 和 `decisions/`。`repositories.yaml` 记录每个业务仓的 branch、commit、MR 和 CI 稳定引用；它不是跨仓事务，也不复制代码。

Jira 内容变化时，`drift` 返回 exit code 3 并暂停；接手者先决定刷新、保留还是重做，不依赖历史聊天。

## L0-L3 安全边界

| 级别 | 示例 | 策略 |
| --- | --- | --- |
| L0 | Jira/GitLab 读取、项目读取 | 可自动执行，外部内容只当数据 |
| L1 | 本地 workitem、分支和测试操作 | 限定目标后可执行 |
| L2 | Jira 更新、`git.push`、创建 MR、MCP 写入 | 先 preview，必须精确 token 和真人确认；写后 reconcile |
| L3 | force-push、merge、部署、权限修改 | MVP 永久禁止 |

通用动作命令示例：

```bash
npm run saber -- action preview jira.update --payload payload.json --json
npm run saber -- action execute jira.update --payload payload.json --confirm <preview-token> --json
```

业务仓 push 使用相同门禁，payload 只接受已配置项目、普通 remote 和本地分支：

```json
{
  "project": "backend",
  "remote": "origin",
  "branch": "feature/PROJ-123"
}
```

```bash
npm run saber -- action preview git.push --payload git-push.json --json
npm run saber -- action execute git.push --payload git-push.json --confirm <preview-token> --json
```

预览会解析并绑定本地 branch commit 和 credential-free remote URL；执行固定为非 force push，禁用仓库 hook，并用 `git ls-remote` 验证远端 ref。

预览记录只保存在本地忽略目录，确认值绑定 capability、规范化 payload 和目标摘要；不能跨请求或跨服务实例重放。

## 外部技能和 MCP 更新

`externalAssets` 只登记上游仓库和选中的子目录。更新默认是 dry-run：

```bash
npm run saber -- external list
npm run saber -- external update
npm run saber -- external update superpowers --apply --confirm
npm run saber -- external update openspec --apply --confirm
```

Saber 使用 `.saber/cache/saber-v1/` 保存 sparse Git 缓存，并只将选中的完整包放到 `.saber/external/saber-v1/{skills,mcp}/`。缓存、manifest 和物化包不提交；工具只看到 `materialize` 为当前角色投影的内容。新增或删除外部包只修改 `saber.yaml` 并提交脚手架仓。

## 诊断和验证

```bash
npm run saber -- validate --json
npm run saber -- doctor --json
npm run saber -- status --json
npm run check
npm test
npm run build
```

`doctor` 会区分未配置的可选 connector、不可用工具、缺失项目和配置错误，不会把未配置报告为成功。外部技能缺失时，`materialize` 会打印可执行的 `external update` 恢复命令。

`validate` 还会检查 `roleProfiles` 引用的团队技能和 workflow 是否存在，避免把坏的角色入口物化到成员工具中。

## CI

GitHub Actions 使用 Node 20，执行 `npm ci`、TypeScript check、完整测试、build 和 `validate --json`。CI 只验证仓库资产，不需要任何 Jira、GitLab、MySQL 或 IdeaMCP 凭证。

## 明确不包含的能力

MVP 不包含 L3 操作、自动外部更新、自治多 Agent 编排、中央权限审计平台、测试平台直连、第三种以上 AI 工具的专属适配、自动 commit、merge 或 deploy。代码修改和 commit 仍由成员在对应业务仓中按团队 Git 规则执行；Saber 只为显式 `git.push` 提供 L2 预览、确认和远端核对。先用至少三个真实需求验证 BA → Dev → QA → 多仓 MR 的黄金路径，再扩展能力。
