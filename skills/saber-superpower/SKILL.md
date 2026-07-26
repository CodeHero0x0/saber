---
name: saber-superpower
description: 在统一 Saber 工作项中，使用 Superpowers 方法集合处理当前请求。
user-invocable: true
---

# Saber Superpowers 桥接

`/saber-superpower <自然语言请求>` 先识别当前工作项或 Jira Key，只读取其
`requirements.md`、`plan.md` 与 `progress.md`。它优先使用 `superpowers` 的最小相关方法：
需求与设计不明确时使用 brainstorming，已批准的多步骤变更使用 writing-plans，实现使用
executing-plans，失败使用 systematic-debugging，交付前使用 verification-before-completion
或 requesting-code-review。

Superpowers 方法的结论和证据必须写回当前工作项：需求变化写入 `requirements.md` 的
`REQ-CHG-*`，计划变化写入 `plan.md` 的 `PLAN-REV-*`，实现、测试、QA 发现和交付总结写入
`progress.md`。不要把方法自身建议的额外目录或文档当作正式工作项产物，除非用户明确要求。

只读操作可直接执行；任何 L2 外部写入必须预览并等待精确确认 token；L3 禁止。
