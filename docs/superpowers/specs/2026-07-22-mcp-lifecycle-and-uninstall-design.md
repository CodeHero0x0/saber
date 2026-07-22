# Saber MCP 生命周期与安全卸载设计

## 目标

Saber 为 Codex、Claude Code 和 OpenCode 提供项目级 MCP 安装、更新、检查和卸载能力，并将它与现有命令、skills、工作流和角色上下文物化为一次事务。

业务用户仍然只在 AI 工具中使用 `/saber` 和自然语言。`saber use`、`saber materialize`、`saber doctor`、`saber uninstall` 是工作区管理员维护入口。

本设计必须满足以下约束：

- 只修改当前 Saber 工作区或指定业务项目，不修改用户全局工具配置。
- 不在工具配置、运行清单、日志或错误中保存 `.env` 的密钥值。
- 只有运行清单能够证明由 Saber 管理的内容才允许更新或删除。
- 任何托管内容被人工替换或修改时，整次操作停止。
- 不保留旧 schema 或双套兼容逻辑。
- 角色上下文不是授权。L2 外部写入继续要求精确 preview/confirm，L3 禁止执行。

## 范围

本次交付包括：

- 团队和个人 MCP 配置模型。
- `stdio` 与 Streamable HTTP MCP transport。
- Codex、Claude Code、OpenCode 项目级原生配置适配器。
- 从 `.env` 安全加载运行时值的 MCP bridge。
- MCP tool 到 Saber capability 的显式映射和风险执行策略。
- `saber use/materialize` 的统一物化事务。
- 定向卸载和显式全量卸载。
- `doctor`、测试、中文配置示例和精简 README。

本次不包括：

- 用户全局 MCP 安装。
- 管理或删除 AI 工具保存的 OAuth token。
- 自动迁移旧配置或旧运行清单。
- 强制终止已经运行的 AI 工具或 MCP 进程。
- 通过名称前缀猜测并删除没有清单的内容。

## 配置模型

### 团队配置

`saber.yaml` 升级到唯一支持的 `schemaVersion: 3`。团队 MCP 统一放在 `mcp.servers`，不新增独立 YAML 文件。

```yaml
schemaVersion: 3
name: Saber

mcp:
  servers:
    # 本地 stdio MCP。command 和 args 不经过 shell。
    - id: idea
      transport: stdio
      command: node
      args:
        - tools/idea-mcp/server.js
      cwd: .
      # 左侧是下游进程变量名，右侧是 .env 中的变量名。
      env:
        IDEA_TOKEN: IDEA_MCP_TOKEN
      tools:
        - name: inspect_project
          capability: idea.project.read
        - name: execute_command
          capability: idea.command.execute

    # 远程 Streamable HTTP MCP。header 值同样引用 .env 变量名。
    - id: team-mysql
      transport: http
      url: https://mcp.example.com/mysql
      headers:
        Authorization: MYSQL_MCP_AUTH
      tools:
        - name: query
          capability: mysql.read
        - name: execute
          capability: mysql.write
```

`stdio` server 允许 `id`、`transport`、`command`、`args`、`cwd`、`env`、`tools`。HTTP server 允许 `id`、`transport`、`url`、`headers`、`auth`、`tools`。两种 transport 不得混用对方专属字段。

HTTP `auth` 只允许 `none` 或 `oauth`，默认为 `none`：

- `none` 可配置由 `.env` 提供的 headers，并通过 Saber bridge 连接。
- `oauth` 不允许配置 Saber headers，由工具适配器生成原生 HTTP 条目，用户在 AI 工具中完成授权。

每个 `tools` 条目必须包含上游 MCP tool 的精确名称和一个已声明的 Saber capability。server ID、tool 名称和 capability 映射均不得重复。未知字段、空字符串、危险相对路径和配置交叉引用错误直接失败。

### 个人配置

`saber.local.yaml` 升级到唯一支持的 `schemaVersion: 2`，允许：

- 在 `extensions.mcpServers` 中显式启用团队 server。
- 在本地 `mcp.servers` 中增加个人 server。
- 继续通过角色、项目和 `extensions.capabilities` 选择能力。

个人 server 不得覆盖团队同名 server。个人 MCP tool 只能引用团队已声明的 L0/L1 capability；个人配置不能新增 L2/L3 capability 或降低既有风险等级。

### 环境变量

`.env.example` 只提供带中文说明的变量样例。YAML 中保存的是环境变量名，`.env` 保存实际值。

旧的 `MYSQL_MCP_COMMAND` 和 `IDEA_MCP_COMMAND` 完整命令字符串被删除。Saber 不解析 shell 命令字符串，也不提供旧格式兼容分支。

## MCP 选择规则

物化时先计算角色、项目和个人扩展的有效 capabilities，再选择至少包含一个有效 capability 的 server；`extensions.mcpServers` 可额外选择团队 server，但不会授予其 tool 对应 capability。

server 被选中不代表其所有工具均可用。每个 tool 仍按有效 capability 和风险级别独立过滤：

- 未声明映射的上游 tool 永远隐藏且拒绝调用。
- 不在当前有效 capability 集合中的 tool 隐藏且拒绝调用。
- L0/L1 tool 可由 bridge 向 AI 工具暴露并代理调用。
- L2 tool 不出现在 bridge 的普通 `tools/list` 中，也不能通过普通 `tools/call` 绕过安全门。
- L3 tool 永远拒绝。

## MCP Bridge

每个非 OAuth server 在工具原生配置中表现为独立的 `saber--<server-id>` stdio MCP server。它启动 Saber 的 TypeScript bridge，并指向本次物化生成的无密钥运行描述文件。

```text
AI 工具
  -> saber--<server-id>
  -> Saber MCP bridge
  -> 本地 stdio MCP 或远程 Streamable HTTP MCP
```

bridge 使用正式 MCP SDK 实现协议客户端和服务端，不手写协议解析：

- 启动时读取运行描述文件和工作区 `.env`。
- stdio 下游使用参数数组、`shell: false` 和受控环境变量启动。
- HTTP 下游使用 Streamable HTTP transport，并在请求时注入允许的 header。
- `tools/list` 只返回当前有效且为 L0/L1 的显式映射工具。
- `tools/call` 再次校验 server、tool、capability、风险和运行描述文件指纹。
- stdout 只承载 MCP 协议；诊断输出写 stderr，且统一脱敏。
- 下游退出、协议错误、超时和无效响应转换为稳定的 MCP 错误，不泄露环境变量值。

运行描述文件位于 `.saber/runtime/mcp/<tool>/<target>/`，包含 server 配置、允许的 tool 映射、来源配置指纹和 `.env` 变量名，不包含 `.env` 值。

OAuth server 使用工具原生 HTTP transport，不经过 bridge。Saber 管理配置条目，但 OAuth 凭证由工具保存和管理。

## L2 MCP 执行

现有 `saber action preview/execute` 扩展为 MCP executor。L2 capability 在配置中唯一映射到一个 server/tool 后，可按以下流程调用：

1. `/saber` 技能根据用户意图生成 MCP tool arguments，并调用 `saber action preview <capability>`。
2. preview 解析目标 server/tool，规范化 arguments，展示目标、操作、账号标识和脱敏后的参数。
3. confirmation token 绑定 capability、server、tool、目标、规范化 arguments 和配置指纹。
4. 用户明确确认后，`saber action execute` 重新读取配置与事实来源并校验 token。
5. executor 通过与 bridge 共用的 MCP client 调用上游 tool。
6. 执行后读取可用事实来源进行 reconcile；无法确认结果时返回不确定状态，禁止盲目重试。

同一 L2 capability 映射多个 server/tool、上游 tool 未找到、配置指纹漂移、环境变量缺失或 token 不匹配都必须停止。原生 MCP 入口不能直接调用 L2 tool。

## 工具适配器

三个适配器实现同一契约：

```text
inspect(target) -> 当前配置与 Saber 条目
render(desired, current) -> 保留用户内容的新配置
verify(expected, actual) -> 所有权和内容一致性
remove(managed, current) -> 仅移除已证明归属的条目
```

项目级配置位置为：

- Codex：`.codex/config.toml`
- Claude Code：`.mcp.json`
- OpenCode：`opencode.json`

Codex 使用 TOML 结构化解析与序列化；Claude Code 和 OpenCode 使用 JSON/JSONC 对应的结构化解析器。不得通过正则或字符串拼接修改配置。

适配器只生成 `saber--<server-id>` 条目：

- Codex 写入 `mcp_servers`。
- Claude Code 写入 `mcpServers`。
- OpenCode 写入 `mcp`。

原配置的非 Saber 字段和非 Saber MCP 条目必须语义等价地保留。同名条目没有有效运行清单时视为用户内容冲突，不能接管。

若配置文件原本不存在，Saber 创建文件并将其加入当前 Git 仓库的本地 exclude；卸载时仅在清单证明由 Saber 创建且删除条目后为空时删除。已有文件或已跟踪文件始终保留，Saber 不改变其 Git 管理状态。

Claude Code 的项目 MCP 需要用户首次信任；Codex 的项目配置同样只在受信任项目生效。`doctor` 必须把未信任、未授权或需要重启报告为明确状态，而不是宣称已连接。

## 物化事务

`saber use <role> --tool <tool> [--project <name>]` 是管理员的主要入口，一次完成命令、skills、工作流、角色上下文和 MCP 的安装或更新。`saber materialize` 保留为高级入口，但调用同一个领域实现。

事务顺序如下：

1. 加载并严格校验团队配置、个人配置和引用关系。
2. 解析目标工具配置，读取唯一支持版本的旧运行清单。
3. 计算有效 skills、commands、capabilities、MCP servers 和 tools。
4. 验证旧清单中的每个托管链接、文件和原生配置条目仍与记录一致。
5. 暂存角色上下文、symlink、MCP 运行描述文件和新工具配置。
6. 保存恢复快照后原子替换工具配置和生成内容。
7. 最后写入新运行清单；成功后删除事务恢复数据。

任一步失败都恢复原工具配置、原 projections、原运行描述和原清单。进程异常退出留下的事务由下一次 `materialize`、`uninstall` 或 `doctor` 检测并恢复，恢复完成前禁止新的写事务。

## 运行清单

`.saber/runtime/materialize/<tool>/<target>.json` 升级为唯一支持的 `schemaVersion: 3`，至少记录：

- `managedBy: saber`
- tool、角色和项目 target
- 配置文件路径，以及操作前是否存在、是否由 Saber 创建
- 每个 command、skill、workflow、context projection 的精确路径、类型、链接目标或内容指纹
- 每个 MCP 原生配置键、规范化条目内容和指纹
- 每个 MCP 运行描述文件的路径和指纹
- 来源 `saber.yaml`、`saber.local.yaml` 和外部资产清单指纹

旧 schema、未知字段、逃逸目标根目录的路径、重复条目和不匹配的 tool/target 均视为无效清单。无效清单不能用于更新或删除。

## 卸载命令

支持定向和显式全量卸载：

```bash
saber uninstall --tool codex
saber uninstall --tool claude --project backend
saber uninstall --all

saber uninstall --tool codex --apply --confirm <preview-token>
saber uninstall --all --apply --confirm <preview-token>
```

`--all` 不能与 `--tool` 或 `--project` 混用。`--project` 必须与 `--tool` 一起使用。

未带 `--apply` 时只生成预览，列出：

- 每个 tool/target 待删除的 commands、skills、workflows 和上下文。
- 待移除的 `saber--*` MCP 原生条目。
- 待删除的 bridge 描述文件和运行清单。
- 明确保留的用户配置、OAuth token、外部资产缓存和业务仓。
- 所有冲突及其人工处理提示。

preview token 绑定排序后的完整删除计划、目标、当前内容指纹和配置来源指纹。执行前重新计算计划；任何变化使 token 失效。

卸载先预检本次命令的全部目标。任一目标存在以下情况时，整个命令不执行：

- 清单无效或不属于 Saber。
- 托管 symlink 被替换、链接目标变化或路径逃逸。
- 托管生成文件内容变化。
- 原生 MCP 条目缺失、被修改或同名内容不再一致。
- 工具配置无法安全解析。
- 存在未恢复的其他写事务。

执行时先在 `.saber/runtime/transactions/` 保存恢复数据，再移除精确条目。任一步失败恢复所有已变更目标，避免半卸载。

成功后：

- 删除对应运行清单和空的 Saber 运行目录。
- 保留 `skills/`、`roles/`、`workflows/`、`saber.yaml` 和 `saber.local.yaml`。
- 保留 `.saber/external/` 下载缓存。
- 保留 `projects/` 及其中的业务代码和 Git 历史。
- 保留所有非 Saber 工具配置和 OAuth token。
- 提示重启已经打开的 AI 工具，不强制结束进程。

成功卸载后再次执行相同命令返回空计划和成功状态。清单存在但托管内容被人工部分删除不视为幂等成功，而是冲突。

## Doctor

`saber doctor` 增加以下状态：

- MCP 配置 schema 与引用关系。
- command、cwd、URL 和必要 `.env` 变量是否可用。
- 运行清单、运行描述和原生工具条目是否一致。
- 工具配置是否需要项目信任、OAuth 或重启。
- 是否存在未恢复事务。
- L2 tool 是否只能通过 action gateway 访问。

`doctor` 只报告事实，不自动修改工具配置或 OAuth 状态。

## 错误与日志

- 配置错误和所有权冲突使用稳定的 `SaberError`，指出文件、server ID 或托管键，但不回显用户提供的密钥值。
- `.env` 缺失值只报告变量名。
- 子进程 stderr 和远程错误先脱敏再返回摘要。
- JSON 输出提供稳定的状态码、目标和冲突列表，供 skills 与自动化消费。
- 无法证明安全恢复时停止并保留事务目录，`doctor` 给出人工恢复信息。

## 测试策略

### 配置测试

- `stdio`、HTTP header、HTTP OAuth、团队 server、个人 server 和显式选择。
- 重复 ID、重复 tool、未知 capability、未知字段、非法路径、transport 字段混用。
- 旧 `MYSQL_MCP_COMMAND`、`IDEA_MCP_COMMAND` 和旧 schema 被拒绝。

### 适配器测试

- Codex TOML、Claude JSON、OpenCode JSON/JSONC 的解析、合并、验证和删除。
- 非 Saber 配置语义保留。
- 同名未托管条目、篡改条目和畸形配置停止。
- 新建配置文件与已有/已跟踪文件的不同清理规则。

### Bridge 与 action 集成测试

- 使用 mock stdio MCP 和本地 Streamable HTTP MCP 验证 `tools/list`、`tools/call`、超时和错误传播。
- L0/L1 显式工具可见，未映射、无 capability、L2 和 L3 工具不可从普通 MCP 入口调用。
- L2 preview token 绑定 server、tool、arguments 和配置指纹，确认后调用并 reconcile。
- 密钥不出现在原生配置、运行描述、清单、stdout、stderr 和异常对象中。

### 生命周期验收

- 三个工具分别覆盖根工作区和业务项目。
- 安装、角色切换、更新、定向卸载、`--all` 和重复卸载。
- 过期 token、内容篡改、多目标预检失败和故障注入回滚。
- OAuth 配置条目可卸载，但工具保存的 token 不删除。
- CLI JSON 和中文文本输出都与实际状态一致。

最终交付必须通过：

```bash
npm test
npm run check
npm run build
git diff --check
```

还需在临时 Git 仓库中运行 CLI 端到端场景并解析三个工具生成的配置。真实客户端未安装或未登录时，只报告配置级验证；不得宣称已完成真实连接。

## 文档交付

- `saber.yaml`、`saber.local.example.yaml` 和 `.env.example` 使用简短中文注释。
- README 只保留核心能力、快速上手、MCP 配置、卸载和验证命令。
- 管理员命令与业务用户 `/saber` 工作方式保持明确分离。

## 实施顺序

1. 配置 schema、模型与验证。
2. MCP client、bridge 和风险过滤。
3. 三个原生工具适配器。
4. 将 MCP 接入统一 materialize/use 事务和运行清单。
5. 扩展 L2 action executor。
6. 实现 doctor 与统一卸载事务。
7. 补齐示例、README 和整体测试。

