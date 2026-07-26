---
name: saber-grill
description: 在统一 Saber 工作项中，使用 Grill Me 逐项质询需求、方案与风险。
user-invocable: true
---

# Saber Grill 桥接

`/saber-grill <自然语言请求>` 先识别当前工作项或 Jira Key，再按 Grill Me 的方式一次只追问
一个会改变目标、范围、验收、风险、责任或授权的问题。不要虚构结论、系统访问、审批或测试
结果。

将已确认结论、备选方案、未决风险和下一责任人写入同一个 `workitems/<ID>.md` 的设计或风险部分；
若这改变需求或计划，在正文中记录 `REQ-CHG-*` 或 `PLAN-REV-*`。不要创建独立的质询记录文件。

L2 外部写入必须预览并等待精确确认 token；L3 禁止。
