---
name: superpowers
description: Use when selecting the smallest relevant Superpowers method for a Saber workitem without turning every task into a ceremony.
---

# Select a relevant Superpowers method

Choose only the method that matches the current risk and task shape:

- Use **brainstorming** before a new feature, behavior change, or architecture decision that is not yet approved.
- Use **writing-plans** for a confirmed multi-step change with dependencies or review points.
- Use **executing-plans** for an approved implementation sequence; add focused tests whenever a behavior contract can be stated clearly.
- Use **systematic-debugging** for an unexpected failure: reproduce, isolate, find root cause, then change code.
- Use **requesting-code-review** after a material implementation and **verification-before-completion** before claiming a check passed.

Follow the selected method's current instructions. A method never changes human ownership, bypasses L2 confirmation, or converts an unverified claim into evidence.

将风险、验证命令和证据引用写入当前 `workitems/<ID>.md` 的设计、验证或交付部分。
