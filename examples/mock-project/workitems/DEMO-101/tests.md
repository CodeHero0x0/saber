# QA 测试证据产出 - DEMO-101

## 首轮测试

| 检查项 | 仓库 | 证据引用 | 结果 |
| --- | --- | --- | --- |
| 199 字符备注 | frontend/backend | qa-run-demo-1 | 通过 |
| 200 字符备注 | backend | qa-run-demo-1 | 失败，错误返回 `ORDER_NOTE_TOO_LONG` |
| 201 字符备注 | frontend/backend | qa-run-demo-1 | 通过，按预期拒绝 |

QA 结论为 `fail`，返回 Dev 修复边界条件。

## 修复后回归

| 检查项 | 仓库 | 证据引用 | 结果 |
| --- | --- | --- | --- |
| 0、1、199、200 字符备注 | frontend/backend | ci-demo-frontend-102 / ci-demo-backend-202 | 通过 |
| 201 字符备注 | frontend/backend | qa-run-demo-2 | 通过，按预期拒绝 |
| 未填写备注的存量订单 | backend | ci-demo-backend-202 | 通过 |

QA 结论为 `pass`，所有验收标准已有可复现证据，可以交给 BA 最终验收。
