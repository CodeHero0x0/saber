---
name: saber-grill-with-docs
description: 在统一 Saber 工作项中，使用 Grill With Docs 核验技术主张。
user-invocable: true
---

# Saber Grill With Docs 桥接

`/saber-grill-with-docs <自然语言请求>` 先识别当前工作项或 Jira Key，再列出需要核验的主张，
只使用官方产品文档、标准机构或维护中的项目规范等权威来源。每条结论必须注明标题、URL 或
本地路径、版本或获取日期、章节及适用限制，并区分事实与推断。

将主张、证据、冲突和待决取舍写入同一个 `workitems/<ID>.md` 的设计或验证部分。若证据导致需求
或计划变化，在正文中关联 `REQ-CHG-*` 或 `PLAN-REV-*`；验证执行和遗留风险也写入该工作项。不要
创建独立的证据工作项文件。

L2 外部写入必须预览并等待精确确认 token；L3 禁止。
