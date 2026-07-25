# Immersive Architecture

## 1. Goals

Immersive is a financial-research Agent workspace. The architecture optimizes for explainable runs, replaceable data/model adapters, structured failures, and small task-local context for human and AI contributors.

## 2. System Context

```mermaid
flowchart LR
  User[Research user] --> Web[Immersive Web]
  Web -->|HTTP + SSE DTO| API[API adapter]
  API --> Agent[Agent runtime]
  Agent --> Tools[Tools and MCP]
  Agent --> RAG[RAG]
  Agent --> Report[Report workflow]
  Agent --> Trace[Run events and trace]
  Tools --> Sources[Market and filing sources]
  RAG --> Sources
```

## 3. Dependency Direction

- `apps/web` depends only on browser libraries and `@aiagent/types`.
- `apps/api` is a transport/composition adapter. It may compose runtime packages but must not implement Agent, RAG, tool, workflow, or report rules.
- `packages/agent` owns an end-to-end research run and coordinates report-mode execution.
- `packages/tools`, `packages/rag`, `packages/workflow`, and `packages/report` own their bounded contexts.
- `packages/trace` owns event recording, sanitization, subscription, and trace projections.
- `packages/types` owns transport contracts only and has no runtime dependencies.
- Packages import other packages through declared public entrypoints. Deep cross-package imports and dependency cycles are forbidden.

## 4. Internal Package Shape

Large bounded-context packages use these responsibilities when needed:

- `domain`: stable concepts, invariants, and policies.
- `application`: use cases and ports.
- `adapters`: replaceable infrastructure such as in-memory stores, providers, and renderers.
- package entrypoint: the smallest supported public API.

The Web is feature-first: `app`, `features`, `entities`, and `shared`. A feature may contain `ui`, `model`, `api`, and `lib`; empty ceremonial folders are not created.

## 5. Runtime View

1. Web creates a run through the API.
2. API route delegates creation to `RunApplicationService`; PostgreSQL atomically creates the Run, idempotent user message, and reserved assistant message.
3. The application service schedules execution and Agent/Report emit one canonical event stream; the Trace recorder redacts it before any persistence boundary.
4. PostgreSQL locks the Run and Trace rows, appends each Trace event and its Run `trace_event` projection in one transaction, and assigns continuous sequence values; only after commit does the in-memory bus fan out live events.
5. Web projects events into assistant-message progress and an on-demand detail panel.
6. A terminal event provides the final structured result. Explicit cancellation propagates through an execution registry owned `AbortSignal`.
7. SSE replays persisted events, subscribes to the process-local bus, buffers live delivery during a catch-up query, then merges and drains only continuous sequences. A later live gap triggers another persisted-event query. `RunStore`, `RunEventBus`, and `RunScheduler` remain separate ports.
8. Trace persistence is an observability side path: a database failure emits a structured internal warning and marks the terminal result `tracePersistence: degraded` without exposing the raw exception or failing the Agent answer.

## 6. Quality Attributes

- Explainability: every meaningful model, retrieval, tool, workflow, approval, and artifact transition is observable.
- Safety: untrusted inputs are validated, sensitive values are redacted, and approvals bind to run and input digest.
- Replaceability: provider-specific behavior stays behind ports and adapters.
- Evolvability: dependency rules, strict types, tests, and documentation checks prevent architecture drift.
- Demo honesty: mock data is labelled and never presented as live market data.

## 7. Decisions and Risks

Architecture-significant decisions live in `docs/decisions/`. Run snapshots/events, messages, RAG ingestion lineage, workflows, and artifact metadata are persisted in PostgreSQL; live event subscribers, cancellation controllers, trace, approval, and vector indexes remain process-local. A restart marks only stale non-terminal Runs as an explainable `run_interrupted` failure; automatic execution continuation remains a worker/queue follow-up.
