# Use canonical run events over SSE

## Status

Accepted

## Context and Problem Statement

The Web currently receives a completed Agent response and separately starts report workflow behavior. This prevents real-time progress and places orchestration in the browser.

## Decision Outcome

Use one structured run-event stream as the source for Trace persistence, SSE delivery, progress UI, and final snapshots. Use HTTP to create/cancel/approve runs and SSE for server-to-browser progress.

## Consequences

- Agent owns end-to-end run orchestration.
- SSE supports ordered replay after reconnect.
- Token-by-token answer streaming is excluded from the first implementation.
- Run events and their current Run projection are persisted atomically in PostgreSQL.
- The database assigns a continuous per-Run sequence under a row lock; terminal state transitions are protected by the same lock.
- SSE accepts `Last-Event-ID` or `afterSequence`, replays persisted events, subscribes live, and buffers live delivery until a second catch-up query can merge and drain events in continuous sequence order.
- The in-memory event bus is deliberately non-durable and only fans out events after the database transaction commits.
