# Saber · 团队 AI 研发资产框架

> 设计规格 v1 · 2026-07-21
> 状态：已批准，等待实施计划

## 1. 产品定位

Saber 是团队共同维护的 AI 研发脚手架，核心是可版本化、可组合、可审计的 AI 研发资产仓库。Git 脚手架是分发与运行载体，工作流标准是资产的一种，平台编排能力后续集成。

一句话定义：团队通过 Git 共用一套 AI 工作流资产，让 BA、Dev、QA 使用不同 AI 工具完成需求确认、开发、测试与修复。

## 2. 已批准的核心决策

| 决策项 | 选择 |
|---|---|
| 产品内核 | 团队 AI 研发资产仓库 |
| 更新模型 | Git 仓库最新版即团队标准 |
| 跨工具策略 | 中立规范 + 工具适配器 |
| 事实源分治 | Jira 管业务；工作项包管研发上下文；GitLab 管代码交付 |
| 工作区模型 | 嵌套 clone + 防误操作护栏 |
| 贡献与发布 | 所有成员可修改并直接 push 主分支 |
| 外部写入 | 读取自动；写入预览后由真人确认 |
| MVP 黄金路径 | Jira 需求到至少两个业务仓库的 MR |
| 协作模型 | 真人 BA、Dev、QA + 各自的 AI 助手 |

## 3. 仓库结构与 Git 边界

~~~text
saber/                         # 团队 AI 研发资产 Git 仓库
├── README.md                  # 最短上手路径
├── saber.yaml                 # 框架、安全基线、默认策略
├── workspace.yaml             # 业务项目清单
├── roles/                     # 真人责任与交接规则
├── workflows/                 # 需求、开发、测试、修复流程
├── skills/                    # 中立团队技能
├── adapters/                  # Codex、Claude 薄适配层
├── mcp/                       # 能力声明，不含凭证
├── workitems/                 # 跨仓任务包
├── bin/                       # 初始化、状态、护栏等薄命令
└── projects/                  # 父仓整体忽略
    ├── frontend/.git          # 独立业务仓库
    └── backend/.git           # 独立业务仓库
~~~

Git 使用当前目录向上遇到的最近一个 .git。saber 根目录操作属于资产仓；projects/frontend 内操作只属于前端仓，其他业务仓同理。

关键约束：

- projects/ 整体加入父仓 .gitignore，不使用 submodule。
- 业务项目可自由切分支、提交、创建 MR。
- 脚手架资产修改与业务工作项修改分开提交。
- 工作项只引用业务仓 commit、MR 和 CI，不复制代码。
- token、账号、私密地址不得进入仓库。

## 4. 中立资产与工具适配

### 4.1 四类中立资产

| 资产 | 职责 | 非职责 |
|---|---|---|
| role | 真人责任、输入、交接产物、最终问责 | 不把 AI 人设当平台权限 |
| workflow | 阶段、进入条件、步骤、产物、门禁、暂停点 | 不承担复杂调度 |
| skill | 一类具体工作的说明、模板和检查方法 | 不重复全局规则或完整流程 |
| capability | jira.read 等语义能力与风险等级 | 不保存 MCP 实例或凭证 |

中立资产使用 Markdown 正文加少量 YAML 元数据，不创造工作流 DSL。同一 workflow 只有一份正文。

### 4.2 适配器契约

- detect：检测 Codex、Claude 和可用连接能力。
- materialize：生成工具可发现的本地入口和索引。
- validate：检查格式、引用和必需能力。
- doctor：报告缺失能力和明确的人工降级路径。

根级 AGENTS.md 与 CLAUDE.md 是提交到 Git 的薄启动入口。工具映射和原生增强位于 adapters/codex 与 adapters/claude。本地生成物位于被忽略的 .saber/runtime/tool，不作为事实源。

适配只保证阶段产物和质量门禁一致，不保证提示文本、交互形式或工具调用顺序完全相同。工具专属增强必须声明无等价能力时的降级行为。

## 5. 工作项包与跨真人交接

~~~text
workitems/PROJ-123/
├── workitem.yaml       # Jira 引用、来源指纹、目标仓库
├── requirements.md     # 澄清后的范围、验收标准、未决项
├── design.md           # 跨仓设计和接口影响
├── plan.md             # 分仓步骤、依赖顺序、验证计划
├── tests.md            # 测试策略、结果和证据引用
├── repositories.yaml   # 每仓分支、commit、MR、CI 状态
├── handoffs/           # 按时间和角色追加的交接记录
└── decisions/          # 关键决策记录
~~~

### 5.1 事实源分治

| 系统 | 权威内容 | 工作项保存内容 |
|---|---|---|
| Jira | 业务背景、原始需求、负责人、业务验收、流程状态 | URL、key、updatedAt、内容指纹、确认后的澄清快照 |
| Saber workitem | 跨仓设计、计划、决策、交接、测试证据索引 | 完整研发上下文；本地阶段不冒充 Jira 状态 |
| GitLab | 代码、分支、commit、MR、Review、CI、制品 | 稳定引用和摘要，不复制 diff 或日志 |

### 5.2 黄金路径

1. Intake：读取 Jira 并建立来源指纹。
2. BA：澄清范围和验收标准。
3. Dev：完成跨仓设计并声明目标项目。
4. Build：在各业务仓独立实现。
5. Verify：执行相关测试并记录证据引用。
6. Deliver：预览并确认创建 MR、回填 Jira。

### 5.3 交接、并发与漂移

- 每阶段结束追加一份 handoff；接手者不依赖历史聊天。
- 进入新阶段前比较 Jira updatedAt 或内容指纹。发生漂移则暂停、展示差异，由真人决定刷新、保留或重做。
- 不维护全局 workitems 索引，handoff 使用追加文件，减少主分支热点冲突。
- repositories.yaml 按仓记录独立结果，不把跨仓交付描述成原子事务。
- 外部写入成功后查询事实源再记录引用；重试前先检查是否已完成。

工作项包不得保存业务代码副本、Jira 流程状态副本、大段 CI 日志、MR diff，或把未确认的 AI 推测记为事实。

## 6. 安全与授权

### 6.1 能力风险级别

| 级别 | 示例 | 默认策略 |
|---|---|---|
| L0 读取 | jira.read、gitlab.mr.read、test.result.read | 可自动执行；外部内容只作为数据 |
| L1 本地可逆 | workitem.write、branch.create、test.local.run | 可自动执行，限定目标并记录结果 |
| L2 外部写入 | jira.update、git.push、gitlab.mr.create | 展示账号、目标、精确变更，真人逐批确认 |
| L3 高破坏/提权 | force-push、merge、删除、部署、权限修改 | MVP 默认不支持，禁止通过 skill 降级 |

### 6.2 外部写入协议

Resolve（映射能力到 MCP/CLI）→ Preview（展示账号与变更）→ Confirm（真人确认本批动作）→ Execute（用真人凭证执行）→ Reconcile（查询事实源后记录结果）。

### 6.3 资产健康闭环

直接 push → CI 事后检查（schema、引用、secret、smoke test）→ doctor 启动 workflow 前检查 HEAD 健康状态 → 不健康则禁止新 workflow（允许只读诊断）→ 真人确认修复或 revert。

团队必须诚实接受：CI 不能阻止坏提交进入 main；直推不能消除并发冲突；revert 仍是一次需确认的共享写操作。

### 6.4 MCP 与凭证

- 仓库只维护 capability 到 connector 的映射、安装说明、非敏感默认值和健康检查。
- 凭证由用户环境、钥匙串或工具自身安全存储管理。
- 仓库只允许变量名和示例占位符。
- MCP 不可用时，workflow 暂停或降级为人工步骤，不得伪造成功结果。
- 外部内容（Jira 描述、MR 评论、CI 日志）不可信，不能授权更高风险操作。

## 7. MVP 验收

### 7.1 可交付范围

| 能力 | 要求 |
|---|---|
| 工作区 | clone 后通过 workspace.yaml 拉取至少两个独立仓库；状态命令显示每仓路径、分支与 dirty 状态 |
| 团队资产 | BA 需求澄清、Dev 设计与实现、QA 测试设计、交接、交付五类核心 skill/workflow |
| 工具适配 | Codex 与 Claude 能发现同一资产、打开同一工作项并生成相同必需产物 |
| Jira 集成 | 读取真实需求、检测来源漂移；更新前展示预览并由真人确认 |
| GitLab 集成 | 读取项目与 CI；push 和创建 MR 前展示预览并由真人确认 |
| 故障恢复 | MCP 缺失、Jira 变化、单仓测试失败、重复 MR、坏资产 HEAD 都有明确暂停和恢复路径 |

### 7.2 验收场景

1. Happy Path：BA（Codex）→ Dev（Claude）→ 前后端提交 → QA（任一工具）→ 两个 MR → Jira 回填。
2. Handoff：新成员只 clone/pull、配置个人凭证并打开 workitem，不读历史聊天也能准确继续。
3. Failure：断开 Jira MCP、修改 Jira 内容、后端测试失败、重复运行 MR 创建，均得到可恢复且不重复写入的结果。

### 7.3 测试矩阵

| 层 | 自动验证 |
|---|---|
| 静态资产 | YAML/frontmatter schema、唯一 ID、引用、模板字段、路径、secret 扫描 |
| 适配器契约 | Codex/Claude materialize golden test；生成入口引用同一资产且不含凭证 |
| 工作项状态 | fixture Jira/GitLab 下的 create、resume、handoff、drift、partial failure、reconcile 测试 |
| 安全 | L0/L1 自动；L2 无确认不得执行；L3 始终拒绝；外部恶意文本不能改变风险级别 |
| Git 隔离 | 父仓忽略 projects/；前后端 branch/commit 互不影响；根级命令显示实际 Git 目标 |
| 人工试点 | 真实 BA、Dev、QA 各至少一人，用两个 AI 工具跑完同一需求 |

### 7.4 成功指标

| 指标 | 试点门槛 |
|---|---|
| 上手 | 已有本机依赖和权限时，新成员 30 分钟内完成初始化、doctor、打开工作项 |
| 交接完整性 | 接手者无需历史聊天即可说明范围、状态、证据、风险与下一步 |
| 跨工具一致性 | Codex 与 Claude 均产出全部必需文件与门禁结论；允许措辞和交互不同 |
| 外部写入安全 | 100% L2 动作有可见预览与真人确认，0 次重复 MR 或非预期 Jira 更新 |
| 团队价值 | BA、Dev、QA 各自认为工作项包减少了至少一次关键上下文追问，而非增加文档负担 |

### 7.5 明确延期

Milestone 1 不包含测试平台直接集成、版本 lock 文件、第三种 AI 工具、自治多 Agent 编排或中央权限审计平台。全局禁止 L3 动作。黄金路径未稳定跑完 3 个真实需求前，不新增能力或工具。

## 8. 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-07-21 | 初始版本 | grill-me 访谈 + 五段设计确认 |
