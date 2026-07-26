---
name: saber-openspec
description: 在统一 Saber 工作项中，使用 OpenSpec 的探索、提案、实施与归档方法。
user-invocable: true
---

# Saber OpenSpec 桥接

`/saber-openspec <自然语言请求>` 使用 Saber 的 `openspec` 桥接来探索、提出、实施或归档当前
工作项。先识别工作项或 Jira Key，只读取对应的 `workitems/<ID>.md`。

探索与提案结论写入工作项的范围、验收与设计部分；批准范围、实施与验证安排写入设计部分；实施证据、
偏差、验证结果和交付总结写入实施、验证与交付部分。需求变化使用 `REQ-CHG-*`，计划修订使用
`PLAN-REV-*`，测试发现使用 `QA-*`，均在同一文件内关联。

不要把外部 OpenSpec CLI 的 `openspec/` 目录、变更目录或额外 Markdown 文件作为该工作项的
正式产物。只读操作可直接执行；L2 外部写入必须预览并等待精确确认 token；L3 禁止。
