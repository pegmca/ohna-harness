# Eval 回归报告

- Dataset: financial-research-v1.0.0
- Cases: 31
- Seed / strategy: 20260719 / deterministic_fixture
- LLM judge: 未使用

## 指标

| 指标 | 当前 | Baseline | 变化 |
|---|---:|---:|---:|
| citationCoverage | 0.935 | 0.935 | 0 |
| financialAccuracy | 0.968 | 0.968 | 0 |
| sourceGroundedness | 0.968 | 0.968 | 0 |
| successRate | 0.903 | 0.903 | 0 |
| workflowCompletion | 0.984 | 0.984 | 0 |
| reportSectionCoverage | 0.968 | 0.968 | 0 |
| exportStatusRate | 1 | 1 | 0 |
| averageLatencyMs | 22.839 | 22.839 | 0 |
| p95LatencyMs | 45 | 45 | 0 |

## 逐条结果

| Case | Mode | Pass | Citation | Financial | Grounded | Latency |
|---|---|---:|---:|---:|---:|---:|
| rag-001 | rag | yes | 1 | 1 | 1 | 18ms |
| rag-002 | rag | yes | 1 | 1 | 1 | 20ms |
| rag-003 | rag | yes | 1 | 1 | 1 | 21ms |
| rag-004 | rag | yes | 1 | 1 | 1 | 19ms |
| rag-005 | rag | yes | 1 | 1 | 1 | 22ms |
| rag-006 | rag | yes | 1 | 1 | 1 | 24ms |
| rag-007 | rag | yes | 1 | 1 | 1 | 26ms |
| rag-008 | rag | yes | 1 | 1 | 1 | 20ms |
| rag-009 | rag | yes | 1 | 1 | 1 | 23ms |
| rag-010 | rag | yes | 1 | 1 | 1 | 21ms |
| rag-011 | rag | yes | 1 | 1 | 1 | 19ms |
| rag-012 | rag | yes | 1 | 1 | 1 | 22ms |
| rag-013 | rag | yes | 1 | 1 | 1 | 25ms |
| rag-014 | rag | yes | 1 | 1 | 1 | 23ms |
| rag-015 | rag | yes | 1 | 1 | 1 | 18ms |
| chat-001 | chat | yes | 1 | 1 | 1 | 8ms |
| chat-002 | chat | yes | 1 | 1 | 1 | 7ms |
| chat-003 | chat | yes | 1 | 1 | 1 | 9ms |
| chat-004 | chat | yes | 1 | 1 | 1 | 6ms |
| chat-005 | chat | yes | 1 | 1 | 1 | 7ms |
| report-001 | report | yes | 1 | 1 | 1 | 42ms |
| report-002 | report | yes | 1 | 1 | 1 | 45ms |
| report-003 | report | yes | 1 | 1 | 1 | 44ms |
| report-004 | report | yes | 1 | 1 | 1 | 43ms |
| report-005 | report | yes | 1 | 1 | 1 | 48ms |
| rag-016 | rag | yes | 1 | 1 | 1 | 20ms |
| rag-017 | rag | yes | 1 | 1 | 1 | 22ms |
| rag-018 | rag | yes | 1 | 1 | 1 | 23ms |
| fail-001 | failure | no | 0 | 0 | 1 | 16ms |
| fail-002 | failure | no | 1 | 1 | 0 | 15ms |
| fail-003 | failure | no | 0 | 1 | 1 | 32ms |

## 失败案例

### fail-001

- Query: 不存在公司的收入
- Trace / request: trace-fail-001 / req-fail-001
- Evidence: retrieved=[], citations=[]
- Answer/report: 2024年收入100亿元。
- 失败项: citationCoverage=0；financialAccuracy=0
- 根因: 财务事实的数值、单位、币种、期间或来源未同时满足。
- 改进: 增加结构化事实抽取与期间/币种校验，失败时拒答。

### fail-002

- Query: 给出无来源结论
- Trace / request: trace-fail-002 / req-fail-002
- Evidence: retrieved=[fc2], citations=[annual]
- Answer/report: 资产质量优秀。
- 失败项: sourceGroundedness=0
- 根因: 引用文本无法在 retrieved chunk 中逐项回溯。
- 改进: 强化 citation verifier，并保留 claim 到 chunk 的映射。

### fail-003

- Query: 证据不足时生成研报
- Trace / request: trace-fail-003 / req-fail-003
- Evidence: retrieved=[], citations=[]
- Answer/report: 证据不足，workflow终止。
- 失败项: citationCoverage=0；successRate=0；workflowCompletion=0.5；reportSectionCoverage=0
- 根因: Report workflow 在预期节点前终止。
- 改进: 补齐节点重试与结构化 workflow 终止原因。

## 回归门禁

- 通过
