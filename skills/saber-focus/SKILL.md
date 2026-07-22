---
name: saber-focus
description: Use when a team member wants to load one existing Saber workitem and its current cross-repository context.
user-invocable: true
---

# Saber 聚焦

`/saber-focus <工作项编号>` 只负责加载一个已有工作项的上下文。读取元数据、统一 `source` 快照与指纹、当前阶段和责任角色、受影响仓库、阶段产物、交接记录及可复查证据。

用中文返回：工作项与来源、当前阶段/责任角色、仓库引用、已有证据、缺失证据和一个建议的下一步。发现来源漂移、文件缺失或状态冲突时明确标为暂停原因。

本命令不修改状态、不补写产物、不运行实现或测试，也不发起外部写入。角色信息仅用于上下文路由，不代表授权。

