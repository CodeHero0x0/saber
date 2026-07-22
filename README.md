# Saber

Saber 是团队共同维护的 AI 编程脚手架：统一角色、工作流、skills、MCP 和工作项状态，并把同一套约定加载到 Codex、Claude Code、OpenCode。`projects/` 下的前后端仓库保持独立 Git 历史。

## 核心能力

- BA → Dev → QA → 修复/回归 → BA 验收的工作项闭环。
- 团队配置 `saber.yaml` + 个人扩展 `saber.local.yaml`。
- MCP 使用结构化配置，经 Saber bridge 过滤 capability；L2 必须先预览并使用绑定目标与载荷的精确确认 token，L3 禁止。
- `materialize` 为三个工具生成项目级 commands、skills、上下文和 MCP 原生配置。
- 外部 skills 集合可更新，配置、运行描述和清单可追踪。
- `uninstall` 按 Saber 所有权精确预览、确认和回滚，不删除用户配置或业务仓。

## 仓库管理员快速上手

要求 Node.js 20+、Git 和至少一个 Codex、Claude Code 或 OpenCode。

```bash
git clone https://github.com/CodeHero0x0/saber.git
cd saber
npm ci
npm run build
cp .env.example .env
cp saber.local.example.yaml saber.local.yaml

# 按注释填写 saber.yaml / saber.local.yaml / .env
npm run saber -- validate --json
npm run saber -- setup --apply --confirm
npm run saber -- use ba --tool codex
```

`use` 是首次安装和日常切换角色的推荐入口；需要精确控制角色、工具或业务仓生成过程时，再使用高级入口 `materialize`。

MCP server 使用结构化配置。下面的 `SABER_PROJECT_API_TOKEN` 是从进程环境或 `.env` 读取的变量名，真实值不写入 YAML：

```yaml
mcp:
  servers:
    - id: project-reader
      transport: stdio
      command: node
      args: [tools/project-reader/server.js]
      env:
        PROJECT_API_TOKEN: SABER_PROJECT_API_TOKEN
      tools:
        - name: inspect_project
          capability: idea.project.read
```

管理员常用命令：

```bash
npm run saber -- doctor --json
npm run saber -- external update --apply --confirm
npm run saber -- materialize --tool claude --role dev --project backend
npm run saber -- materialize --tool opencode --role qa --project frontend
npm run saber -- uninstall --tool codex
npm run saber -- uninstall --all --apply --confirm <preview-token>
```

`saber.yaml` 是团队提交的事实来源；`saber.local.yaml` 只放个人扩展，`.env` 只放环境变量值，这两个本地文件不得提交。业务仓库放在 `projects/`，不提交到 Saber。

## 在 AI 工具中使用

管理员完成 `materialize` 后，业务用户只需在对应工具的对话框输入：

```text
/saber
把这段需求澄清成可验收的工作项，并从 BA 阶段开始。
继续当前工作项，完成后交给 QA。
QA 发现边界失败，请修复并附上回归证据。
```

辅助命令：`/saber-intake` 采集需求，`/saber-focus` 切换工作项，`/saber-status` 查看状态，`/saber-refine` 追问澄清，`/saber-help` 查看入口。用户不需要在日常工作中操作 Saber 状态机 CLI。

## 验证

```bash
npm test
npm run check
npm run build
git diff --check
npm audit --omit=dev
```
