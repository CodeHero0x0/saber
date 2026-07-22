---
name: saber-help
description: Use when a team member needs concise help for the currently visible Saber stage or command.
user-invocable: true
---

# Saber 帮助

`/saber-help` 只提供帮助。根据当前可见阶段，用中文显示现在可做事项、所需输入、预期产物和适用入口；没有上下文时首先推荐 `/saber <描述或工作项编号>` 这个唯一主要入口。

仅在相关时列出 `/saber-intake`、`/saber-focus`、`/saber-status`、`/saber-refine`，不要倾倒内部 CLI 清单。说明角色只是上下文、L2 需要 preview 与精确确认、L3 禁止。

本命令不读取无关业务内容、不改变工作项或文件，也不发起外部写入。

