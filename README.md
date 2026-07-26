# Saber

Saber 是放在团队知识 Git 仓中的 AI 开发脚手架。它把默认技能、工具配置和团队约定准备好，让成员从同一处进入 AI 辅助开发，同时业务代码仍留在各自独立的项目仓。

## 为什么使用 Saber

- 一条命令建立可用的团队 AI 工作区，减少每位成员重复配置。
- 默认提供 Codex、Claude Code 与 OpenCode 的入口和 MCP 配置。
- 团队可以持续沉淀规则、知识与工作项；AI 只在需要时读取相关内容。
- 本机凭证保存在 `.env`，不会写进团队 Git 配置。
- 业务仓中的客户规则始终优先，避免团队资料覆盖项目事实。

## 功能

- 初始化目录、默认技能、团队配置、工作项模板和 AI 工具指引。
- 为 Codex、Claude Code 或 OpenCode 写入本机 MCP 配置。
- 支持单文件工作项、知识校验与按需检索。
- 对外部写入提供预览与确认保护。

## 使用

从 [GitHub Releases](https://github.com/CodeHero0x0/saber/releases) 下载与系统匹配的二进制和 `checksums.txt`。当前提供 Apple Silicon macOS、Linux x64 与 Windows x64；不提供 Intel macOS。

以 macOS Apple Silicon 为例，校验并放入团队知识仓：

```bash
grep -F "  saber-v0.1.1-darwin-arm64" checksums.txt | shasum -a 256 -c -
mkdir -p bin
mv saber-v0.1.1-darwin-arm64 bin/saber
chmod +x bin/saber
./bin/saber init
```

`init` 只补充缺失的文件，不覆盖已有内容。它会生成团队配置、默认技能、AI 工具指引、空工作项与知识目录，以及本机 `.env` 和 `saber.local.yaml`。

填写 `.env` 中需要的本机变量后，选择你使用的 AI 工具：

```bash
./bin/saber init --tool codex
```

随后始终从 Saber 根目录启动 AI 工具，并直接描述要完成的工作：

```text
/saber 为 PROJ-123 梳理范围、依赖和验收标准
```

Saber 不会替代你的业务仓或客户文档；它负责让团队的 AI 开发环境一致、可复用且更安全。
