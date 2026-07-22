# Saber

Saber 是团队共享的 AI 研发资产仓库。BA、Dev、QA 在同一套角色、工作流和技能上协作，Codex、Claude Code、OpenCode 读取相同的团队约定；`projects/` 下的业务仓保持独立 Git 历史。

## 工作方式

Saber 面向两类使用者，入口不同：

- **仓库管理员**使用 CLI 初始化工作区、维护团队配置、更新外部资产并物化各工具上下文。
- **业务用户**在 Codex、Claude Code 或 OpenCode 的对话中使用 `/saber` 或自然语言完成日常研发，不需要输入状态机 CLI。

工作项可来自聊天、文档、Jira 或人工录入。Saber 将经用户确认的输入快照保存为 `intake.md`，并在 `workitem.yaml` 的 `source` 中记录标题、来源类型、快照、指纹、采集时间与引用。随后按 BA → Dev → QA → Dev 修复/QA 回归 → BA 验收流转。

## 管理员：初始化与维护

要求 Node.js 20+、Git，以及至少一个受支持的 AI 编程工具。

```bash
git clone https://github.com/CodeHero0x0/saber.git
cd saber
npm ci
cp .env.example .env
cp saber.local.example.yaml saber.local.yaml

# 填写本机配置后初始化，并为目标工具生成上下文
npm run saber -- setup --apply --confirm
npm run saber -- materialize --role ba --tool codex
```

管理员按需执行以下维护命令：

```bash
# 检查配置与运行环境
npm run saber -- validate --json
npm run saber -- doctor --json

# 预览或应用初始化、外部资产更新
npm run saber -- init
npm run saber -- init --apply --confirm
npm run saber -- external update
npm run saber -- external update --apply --confirm

# 为不同角色、工具或业务仓更新本地上下文
npm run saber -- materialize --role dev --tool claude --project backend
npm run saber -- materialize --role qa --tool opencode --project frontend
```

`saber.yaml`、`roles/`、`workflows/` 和 `skills/` 是团队提交的事实来源。`saber.local.yaml` 保存个人默认角色、工具和本地扩展，`.env` 保存个人凭证与 MCP 命令；二者都不提交。`projects/` 中的前后端项目是独立 Git 仓，也不提交到 Saber 仓库。

个人配置不能新增团队项目、修改团队项目路径、请求 L2/L3 能力或削弱团队安全策略。

## 用户：在 AI 工具中工作

进入已由管理员配置的 Saber 工作区，在 Codex、Claude Code 或 OpenCode 中输入：

```text
/saber
```

`/saber` 会结合当前对话和工作区状态选择下一步。也可以直接说出目标，例如：

```text
把上面的聊天需求纳入 Saber，先帮我澄清验收标准。
继续处理当前工作项，完成后交给 QA。
查看这个需求现在由谁负责、还有什么阻塞。
QA 发现 200 字符边界失败，请修复后重新交给 QA 验证。
```

需要明确指定动作时，可使用辅助命令：

- `/saber-intake`：将当前聊天、文档或外部事项采集为来源快照并创建工作项。
- `/saber-focus`：选择或切换当前工作项。
- `/saber-status`：查看当前阶段、责任角色、证据和阻塞。
- `/saber-refine`：在创建工作项前，结合选定文档继续深化需求草稿。
- `/saber-help`：查看当前工具中可用的 Saber 入口。

这些入口由 AI 工具调用 Saber 的后台工作项接口，负责读取状态、写入阶段产出、保存交接并执行合法流转。业务用户只需描述结论和下一步，不需要手动输入 `open`、`next` 或 `loop` CLI。

## 中文闭环示例

运行管理员提供的 demo 命令可在当前工作区创建一个从 BA 阶段开始的练习工作项：

```bash
npm run saber -- demo
```

完成态示例位于 `examples/mock-project/workitems/DEMO-101/`。它从中文产品群聊 `intake.md` 开始，保留 BA 需求澄清、Dev 设计与首轮交付、QA 边界失败、Dev 修复、QA 回归通过和 BA 最终接受的全部历史与中文阶段产出。

## 外部操作安全

读取和本地可逆操作可按团队策略自动执行。任何 push、创建 MR、更新外部事项等 L2 写入，都必须先展示 `saber action preview` 的目标与规范化载荷，再由真人提供该预览对应的精确确认 token；确认不得复用于不同目标或载荷。L3 破坏性或特权操作在 MVP 中禁止执行。

## 仓库验证

```bash
npm test
npm run check
npm run build
```
