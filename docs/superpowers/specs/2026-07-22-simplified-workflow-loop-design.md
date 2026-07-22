# Saber 简化操作与工作项 Loop 设计

> 日期：2026-07-22  
> 状态：已确认，待实施

## 1. 目标

本次迭代只解决以下五项：

1. 为团队日常操作提供简短、可发现的命令；
2. 为 BA、Dev、QA 在 Codex、Claude Code、OpenCode 中提供一致的角色加载和启动指引；
3. 将通用配置内置到 Saber，团队仓库只保存必要差异，个人通过被忽略的本地配置扩展；
4. 提供一份可阅读、可复制运行的 mock project/workitem；
5. 增加从 BA 开始并可在 Dev 与 QA 之间反复修复验证、最终回到 BA 验收的工作项状态机。

本次不实现多仓批量 checkout、批量交付、版本 lock、通用 MCP 执行器、资产治理平台或团队指标平台。

## 2. 配置模型

### 2.1 三层来源

有效配置按以下顺序形成：

1. Saber 内置 preset：安全策略、标准角色、默认工作流、通用 capability/connector、工具适配和外部技能目录；
2. `saber.yaml`：团队项目清单、团队默认值和选用的 preset；
3. `saber.local.yaml`：个人默认角色/工具、项目 clone 地址和个人扩展。

团队配置示例：

```yaml
schemaVersion: 2
name: Saber

workspace:
  projects:
    - name: frontend
      path: projects/frontend
    - name: backend
      path: projects/backend

externalSkills:
  preset: standard
```

个人配置示例：

```yaml
schemaVersion: 1

defaults:
  role: qa
  tool: claude

projects:
  frontend:
    repository: git@gitlab.example.com:team/frontend.git
  backend:
    repository: git@gitlab.example.com:team/backend.git

extensions:
  skills:
    - my-personal-skill
  capabilities:
    - mysql.read
```

### 2.2 个人配置边界

`saber.local.yaml` 被 Git 忽略，仓库提交 `saber.local.example.yaml`。个人配置可以：

- 选择默认 `role` 和 `tool`；
- 为团队声明的项目补充 `repository`；
- 追加个人技能；
- 追加已经由团队 preset 定义的 L0/L1 capability。

个人配置不得：

- 修改安全策略和风险等级；
- 新建 capability 或 connector 定义；
- 获得 L2 capability；
- 修改团队角色职责、工作流门禁或状态转换；
- 修改项目路径或添加未在团队配置中声明的业务仓。

加载器必须严格校验未知字段，并在合并后使用现有仓库配置验证器做交叉引用检查。旧 `schemaVersion: 1` 完整配置继续兼容，便于平滑迁移。

## 3. 简化命令与角色工具入口

### 3.1 日常短命令

| 命令 | 作用 |
|---|---|
| `saber setup [--apply --confirm]` | 校验配置、检查环境并生成缺失的个人配置模板；默认只预览外部技能更新，显式确认后才执行更新 |
| `saber use <role> [--tool <tool>] [--project <name>]` | 物化角色资产，并输出对应工具的启动命令和该角色常用 Saber 命令 |
| `saber open <key>` | 显示当前阶段、责任角色、缺失产物、暂停原因及下一条建议命令 |
| `saber loop <key>` | 显示整个闭环、当前位置、循环次数和历史摘要，不自行无限执行 AI 或外部工具 |
| `saber next <key> --result <result> [--summary <text>] [--risk <text>] [--next <text>] [--fingerprint <hash>]` | 校验阶段门禁，以带回滚的逻辑事务写入状态推进与 handoff |
| `saber pause <key> --reason <text>` | 记录暂停原因和恢复节点 |
| `saber resume <key> [--fingerprint <hash>]` | 校验 Jira 漂移后恢复到原节点 |
| `saber demo [DEMO-101]` | 从只读 mock 示例复制一份本地可操作工作项；已有目标不覆盖 |

现有 `validate`、`doctor`、`status`、`init`、`external`、`materialize`、`workitem` 和 `action` 命令保持可用，短命令是面向日常协作的稳定入口。

### 3.2 角色与工具行为

`saber use` 支持 `ba|dev|qa` 和 `codex|claude|opencode`。工具解析顺序为显式 `--tool`、个人默认工具、团队默认工具。

命令完成物化后只输出启动命令，默认不自动启动外部程序：

```text
codex .
claude .
opencode .
```

输出同时包含角色常用命令：

- BA：`saber open`、`saber next --result ready|accept|reject`、`saber pause`；
- Dev：`saber open`、`saber next --result ready|blocked`、现有 action preview/execute；
- QA：`saber open`、`saber next --result pass|fail|blocked`、`saber loop`。

## 4. 工作项状态机

### 4.1 状态与责任角色

```text
BA clarify
  -> Dev build
  -> QA verify
      -> fail -> Dev fix -> QA verify
      -> pass -> BA accept
                   -> reject -> Dev fix
                   -> accept -> Done
```

任何活动状态都可进入 `paused`，恢复后返回原活动状态。状态机的稳定状态 ID 为：

| 状态 | 角色 | 允许结果 |
|---|---|---|
| `ba-clarify` | BA | `ready`, `paused` |
| `dev-build` | Dev | `ready`, `blocked` |
| `qa-verify` | QA | `pass`, `fail`, `blocked` |
| `dev-fix` | Dev | `ready`, `blocked` |
| `ba-accept` | BA | `accept`, `reject`, `paused` |
| `done` | 无 | 无 |
| `paused` | 恢复节点对应角色 | `resume` |

`blocked` 进入 `paused`，保存原状态；显式 `paused` 结果等价于 `saber pause`。QA `fail` 或 BA `reject` 将 loop 计数加一并进入 `dev-fix`。Dev fix `ready` 返回 `qa-verify`。

### 4.2 持久化与一致性

`workitem.yaml` 升级为 schema version 2，并加入：

```yaml
workflow:
  state: qa-verify
  role: qa
  iteration: 1
  pausedFrom: null
  pauseReason: null
  updatedAt: "2026-07-22T08:30:45.123Z"
  history:
    - from: dev-fix
      to: qa-verify
      result: ready
      role: dev
      recordedAt: "2026-07-22T08:30:45.123Z"
```

创建工作项时从 `ba-clarify` 开始。读取 schema version 1 工作项时，在内存中兼容为尚未推进的 `ba-clarify`；首次状态写入时升级为 version 2。

状态推进与 handoff 必须作为同一逻辑事务：先验证所有输入和目标路径，在隔离的临时目录生成两个文件，再依次替换目标；任一步失败都回滚到旧状态。历史保存经过长度和字符校验的短结构化记录，不保存聊天、diff 或大段日志。

### 4.3 阶段门禁

- `ba-clarify -> dev-build`：`requirements.md` 存在，Jira 指纹未漂移；
- `dev-build/dev-fix -> qa-verify`：`design.md`、`plan.md` 和 `repositories.yaml` 有效；
- `qa-verify -> ba-accept`：`tests.md` 存在，结果必须是 `pass`；
- `ba-accept -> done`：结果必须是 `accept`，Jira 指纹未漂移；
- `resume`：若提供当前 Jira 指纹，则必须与保存值一致；发生漂移保持暂停。

门禁只验证结构和证据是否存在，不由 Saber 判断业务内容是否正确。角色是责任上下文，不是权限；CLI 不因当前工具加载了某角色就推断真人身份或授权。

## 5. Mock Project 与 Workitem

仓库提交以下只读示例：

```text
examples/mock-project/
├── saber.yaml
└── workitems/DEMO-101/
    ├── workitem.yaml
    ├── requirements.md
    ├── design.md
    ├── plan.md
    ├── tests.md
    ├── repositories.yaml
    ├── handoffs/
    └── decisions/
```

示例内容是一项同时影响前后端的“订单备注字符限制”需求，完整历史为：

```text
BA ready -> Dev ready -> QA fail -> Dev fix ready -> QA pass -> BA accept
```

`saber demo` 将模板复制到当前仓库的 `workitems/DEMO-101`，默认创建一个处于 `ba-clarify` 的可操作副本；只读示例中的完整历史用于学习和测试。命令不得覆盖已有工作项。

## 6. 错误处理与安全

- 非法状态转换返回 exit code 2，不修改任何文件；
- 缺少证据、Jira 漂移、blocked 或人工暂停返回 exit code 3；
- 配置错误不得回显 token、私有 URL 中的凭证或个人配置原文；
- `setup`、`use`、`demo`、状态推进属于仓库内可逆写入；已有文件冲突时停止，不覆盖；
- 所有 Jira、GitLab 和 Git 外部写入继续使用既有 L2 preview、精确 token 和 reconcile；
- loop 只编排人类角色交接，不自动无限调用 AI，不把角色上下文当成外部写权限。

## 7. 验证策略

按阶段成果而非每个小改动执行测试：

1. 配置阶段：v1 兼容、v2 preset 展开、个人合法覆盖、越权覆盖拒绝、secret 不回显；
2. 状态机阶段：完整 happy path、QA fail 修复循环、BA reject 循环、pause/resume、Jira drift、非法转换和写入原子性；
3. 命令阶段：三个角色乘三个工具的 `use` 输出，短命令与底层命令一致；
4. 示例阶段：mock 资产校验、`demo` 可复制且不覆盖；
5. 最终交付：`npm test`、`npm run check`、`npm run build`、`node dist/cli.js validate --json` 和 `git diff --check`。

## 8. 验收标准

- 新成员只编辑精简 `saber.yaml` 和可选 `saber.local.yaml` 即可使用；
- BA、Dev、QA 在任一支持工具下都有一条统一角色加载命令和清晰的下一步；
- 一个工作项可从 BA 澄清开始，经历任意次数 Dev/QA 修复循环，回到 BA 验收并完成；
- `open` 和 `loop` 无需阅读聊天即可说明当前阶段、责任角色、缺失证据、循环次数和下一步；
- mock 工作项能演示完整协作闭环；
- 个人扩展不能削弱团队安全规则或取得 L2/L3 权限。
