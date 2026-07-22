---
name: saber-status
description: Use when a team member needs a read-only progress and evidence summary for Saber work.
user-invocable: true
---

# Saber 状态

`/saber-status [工作项编号]` 只读查看进度。若提供编号，读取该工作项；否则仅汇总本地可见工作项，不猜测远端状态。

用中文列出当前阶段、责任角色、来源指纹状态、阶段产物是否存在、仓库/MR/CI/测试等证据、缺失项、暂停原因和建议动作。把“文件存在”“测试通过”“外部系统已更新”分开陈述，只报告实际读取到的证据。

本命令不修改文件或工作流、不运行补救动作，也不发起外部写入。角色档案只提供上下文，不构成审批或执行权限。

