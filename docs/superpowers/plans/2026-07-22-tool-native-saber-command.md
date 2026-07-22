# 工具原生 Saber 超级命令实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让团队成员在 Codex、Claude Code、OpenCode 中通过 `/saber` 和自然语言启动、推进工作，同时支持非 Jira 需求来源、自动工作项编号和按角色推荐的 Saber 资产。

**Architecture:** 工作项层只保留通用 `source` 模型与内容快照，原有模板、demo 和测试一次性迁移，不保留旧 Jira schema 读取分支；工具层把六个核心命令实现为普通团队技能包，由 `materialize` 对所有角色始终投影。默认角色只提供路由上下文，实际阶段由用户意图和工作项状态决定；个人技能及低风险 MCP 能力继续通过受限本地配置合并。

**Tech Stack:** TypeScript、Node.js 20、YAML、Node test runner、Markdown/SKILL.md。

---

### Task 1: 通用来源、内容快照与自动编号

**Files:**
- Modify: `src/lib/workitems.ts`
- Modify: `src/commands/workitem.ts`
- Modify: `src/cli.ts`
- Modify: `templates/workitem/workitem.yaml`
- Create: `templates/workitem/intake.md`
- Modify: `templates/workitem/requirements.md`
- Modify: `tests/workitems.test.ts`

- [ ] **Step 1: 增加来源与自动编号测试**

增加测试，覆盖 `chat|jira|document|manual` 来源、由 Markdown 内容计算 SHA-256、`SABER-YYYYMMDD-NNN` 同日递增、冲突不覆盖、禁止 `--source-text`，以及明确拒绝包含旧 `jira` 字段的元数据。

- [ ] **Step 2: 运行工作项测试确认新场景尚未实现**

Run: `npx tsx --test tests/workitems.test.ts`

Expected: 新增的通用来源和自动编号断言失败，现有测试继续运行。

- [ ] **Step 3: 实现来源模型和安全文件输入**

在 `workitems.ts` 中增加：

```ts
export type WorkitemSourceKind = "chat" | "jira" | "document" | "manual";
export type WorkitemSource = {
  kind: WorkitemSourceKind;
  title: string;
  origin?: string;
  snapshot: "intake.md" | null;
  fingerprint: string;
  capturedAt: string | null;
  references: string[];
};
```

所有工作项统一写 schema v3 和 `source`。创建接口只接受来源标题、来源文件和引用，计算 `sha256:<hex>` 并写入 `intake.md`；删除 `jiraUrl`/`jira` 运行时字段和 schema v1/v2 分支。Jira 通过 `source.kind: jira`、`origin` 和同一套指纹字段表达。

- [ ] **Step 4: 实现内部 CLI 的文件型来源参数**

支持以下内部接口，且不支持 `--source-text`：

```bash
saber workitem create --source-type chat --source-title "标题" \
  --source-file .saber/runtime/intake/draft.md --project frontend
```

`--source-file` 必须是仓库内普通文件，禁止符号链接、空内容和超出限制的内容。缺少显式 key 时自动生成当日编号；Jira 也只能通过同一组 `--source-*` 参数创建。

- [ ] **Step 5: 运行工作项测试**

Run: `npx tsx --test tests/workitems.test.ts`

Expected: 通用来源、旧 schema 拒绝和现有状态机测试全部通过。

### Task 2: `/saber` 超级命令与辅助技能

**Files:**
- Create: `skills/saber/SKILL.md`
- Create: `skills/saber/references/role-routing.md`
- Create: `skills/saber-intake/SKILL.md`
- Create: `skills/saber-focus/SKILL.md`
- Create: `skills/saber-status/SKILL.md`
- Create: `skills/saber-refine/SKILL.md`
- Create: `skills/saber-help/SKILL.md`
- Modify: `skills/grill-me/SKILL.md`
- Modify: `skills/grill-with-docs/SKILL.md`
- Modify: `tests/repository-assets.test.ts`

- [ ] **Step 1: 增加核心命令资产契约测试**

断言六个技能均有有效 frontmatter、中文工作流、角色推断优先级、来源草稿确认门禁、L2 精确确认约束，并且 `/saber-refine` 明确由用户显式触发 `/grilling`。

- [ ] **Step 2: 创建核心命令技能包**

`skills/saber` 定义统一路由：显式意图 → 工作项状态 → 默认角色 → 语义判断 → 单一澄清问题。其余五个技能只承担强制接入、聚焦上下文、只读状态、文档深化和帮助，不复制状态机规则。

- [ ] **Step 3: 衔接 Grill 技能**

在团队 `grill-me` 与 `grill-with-docs` 说明中增加 Saber 草稿输入/输出约定；保持 `/grilling` 的显式用户触发，不声称模型自动调用。

- [ ] **Step 4: 运行资产测试**

Run: `npx tsx --test tests/repository-assets.test.ts`

Expected: 所有核心命令、团队技能和引用文件契约通过。

### Task 3: 跨工具、按角色的资产物化

**Files:**
- Modify: `src/lib/materialize.ts`
- Modify: `src/commands/convenience.ts`
- Modify: `tests/materialize.test.ts`
- Modify: `tests/convenience.test.ts`

- [ ] **Step 1: 增加跨工具物化测试**

对 Codex、Claude Code、OpenCode 分别断言：六个核心命令始终存在，角色推荐技能/工作流按当前角色选择，个人技能保持合并，角色切换不会移除非 Saber 管理的个人资产。

- [ ] **Step 2: 实现核心命令投影**

在 `materialize.ts` 定义不可被个人配置替换的核心技能 id 集合：

```ts
const coreCommandSkills = [
  "saber",
  "saber-intake",
  "saber-focus",
  "saber-status",
  "saber-refine",
  "saber-help",
] as const;
```

所有角色均投影核心命令；运行时 manifest 记录核心命令和角色推荐技能。聚合上下文以中文说明 CLI 是内部接口、默认角色不是授权、MCP 能力来自团队批准的 connector/capability 映射。

- [ ] **Step 3: 调整初始化反馈**

`saber use` 的管理员输出只报告目标工具、默认角色、已安装命令、推荐技能和启动方式，不再向最终用户推荐 `saber open/next/loop` 等 CLI 日常命令。

- [ ] **Step 4: 运行物化与便捷命令测试**

Run: `npx tsx --test tests/materialize.test.ts tests/convenience.test.ts`

Expected: 三种工具、三种角色、个人扩展和角色切换测试全部通过。

### Task 4: 中文聊天来源 demo 与文档

**Files:**
- Create: `templates/demo/DEMO-101/intake.md`
- Create: `examples/mock-project/workitems/DEMO-101/intake.md`
- Modify: `templates/demo/DEMO-101/workitem.yaml`
- Modify: `examples/mock-project/workitems/DEMO-101/workitem.yaml`
- Modify: `templates/demo/DEMO-101/requirements.md`
- Modify: `examples/mock-project/workitems/DEMO-101/requirements.md`
- Modify: `tests/demo.test.ts`
- Modify: `README.md`
- Modify: `roles/ba.md`
- Modify: `roles/dev.md`
- Modify: `roles/qa.md`
- Modify: `workflows/requirements/SKILL.md`
- Modify: `workflows/develop/SKILL.md`
- Modify: `workflows/test/SKILL.md`
- Modify: `workflows/fix/SKILL.md`

- [ ] **Step 1: 将 demo 来源改为聊天快照**

保留 DEMO-101 的 BA → Dev → QA → Dev 修复 → QA 回归 → BA 验收历史，增加中文 `intake.md`，元数据改为 `source.kind: chat`，测试断言每个阶段产出仍为中文。

- [ ] **Step 2: 重写用户文档入口**

README 快速开始保留管理员初始化命令，日常用法改为 `/saber`、自然语言和辅助命令。角色/工作流文档删除要求业务用户直接输入 CLI 的表述，改为工具内职责、产出和安全门禁。

- [ ] **Step 3: 运行 demo 和文档资产测试**

Run: `npx tsx --test tests/demo.test.ts tests/repository-assets.test.ts`

Expected: 聊天来源、中文阶段产出和精简文档契约全部通过。

### Task 5: 整体回归、审查和交付

**Files:**
- Modify only files required by failures discovered in this task.

- [ ] **Step 1: 执行全量测试**

Run: `npm test`

Expected: 全部测试通过，失败数为 0。

- [ ] **Step 2: 执行类型、构建与配置验证**

Run: `npm run check`

Run: `npm run build`

Run: `node dist/cli.js validate --json`

Expected: 类型检查和构建退出码为 0，配置报告为 `{"valid":true,"errors":[]}`。

- [ ] **Step 3: 审查差异与工作区**

Run: `git diff --check`

Run: `git status --short`

Expected: 无空白错误；只有本计划范围内的文件发生变化。

- [ ] **Step 4: 提交并推送 main**

```bash
git add <本计划涉及的文件>
git commit -m "feat: add tool-native saber command workflow"
git push origin main
```

Expected: 本地与 `origin/main` 指向同一提交；不使用 force push，不包含 `projects/`、`.saber/`、工具投影目录或个人配置。
