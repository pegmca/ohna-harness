# 带读路线：工程化落地 P1（worker 解耦）与 P2（SSE 背压）（v1.1）

> 配套文档：`docs/v1.1/05-engineering-deployment.md`（行业速览、差距与改造方向）
> 本路线把 P1（执行与 HTTP 解耦为 worker + PG 队列 + lease）与 P2（SSE token 流式背压）按
> "心智模型 → 队列/租约机制 → worker loop → 崩溃恢复 → SSE 背压"的顺序，把代码位置、设计思想、
> 表达与学习检查点串起来。读法建议：先读一节的理论，再打开对应 `file_path:line` 读源码，最后回看「学习检查点」。

---

## 0. 全局心智模型（先看这张图）

```
    HTTP 请求（POST /api/runs）                  worker loop（同进程内，可独立拆分）
   ┌──────────────────────────────┐            ┌─────────────────────────────────────┐
   │ create():                    │            │ createRunWorker():                 │
   │  store.create(status=queued)  │            │  poll → claimNext(SKIP LOCKED)      │
   │  + request_payload 落库       │  ── 入队 ─▶│   → renewLease 续期                  │
   │  + publish(run_status=queued) │   PG runs  │   → execute() 逐事件落库广播         │
   │  立即返回 202                │   队列      │   → 终态后 lease 自动失效            │
   └──────────────────────────────┘            └──────────────┬──────────────────────┘
                                                              │ 崩溃/重启
                                                              ▼
                                                  recoverStale():
                                                  过期 lease 的 running → 重置 queued 重排
                                                  （at-least-once：崩溃不丢 run）

   SSE 端点（/api/runs/:id/events）
   ┌──────────────────────────────┐
   │ ordered-run-event-stream      │  write()→boolean：返回 false 时暂停 drain
   │  replay + live + 背压        │  reply.raw.on("drain") → stream.resume()
   └──────────────────────────────┘
```

**一句话**：P1 把"接收请求即执行"（microtask scheduler，崩溃丢 run）重构为"接收即入队 + worker 异步消费"，用 PG 行锁 + lease 实现 durable run 的 at-least-once 语义；P2 把 SSE 的 `write()` 返回值当成背压信号，下游缓冲满时暂停推送、drain 时恢复，避免高吞吐 token 流打爆客户端 socket。

---

## 1. P1 心智模型：为什么"入队/执行解耦"是 Agent 上生产的分水岭

**读什么**
- `docs/v1.1/05-engineering-deployment.md:9` 行业现状："Durable runs 成主流——Agent 执行与 HTTP 解耦为 worker + queue + lease + outbox/inbox，保证 at-least-once、重启可恢复、副作用幂等。"
- 改造前（`apps/api/src/application/run-service.ts` 旧 `create`）：`scheduler.schedule(() => execute(...))` 用 `queueMicrotask` 在 HTTP 进程内同步执行；进程崩溃/重启，`runs_v2` 停在 `queued`/`running` 且无人接管 → **run 丢失**。

**核心概念**
- **at-least-once**：一条 run 至少被执行一次。崩溃后由恢复逻辑重排，可能被执行两次（本实现的 tradeoff，见第 5 节）。
- **状态机**：`queued → running → completed/failed/cancelled/interrupted`（`run-repository.ts` 的 `TERMINAL` 集合与 `canTransition`）。终态不可逆。
- **lease（租约）**：worker 抢占 run 时设 `lease_until = now + duration`；执行期间心跳续期；过期则被认为"worker 已死"，可被其他 worker 重新 claim。

**学习检查点**
- 为什么不直接把 run 写进 Redis/BullMQ？学习项目用 PG 原生 `FOR UPDATE SKIP LOCKED` 即可实现无外部依赖的 durable queue，且 run 的"请求快照"与"事件流"本就在 PG，放同一事务最一致。生产可平滑替换为专用队列。
- 为什么把执行放"同进程 worker loop"而不是独立进程？单进程已能演示 queue+lease+恢复的全部核心语义，且避免了多进程的序列化/部署复杂度；架构上 `claimNext` 的 `SKIP LOCKED` 已为多 worker 预留（见第 4 节）。

---

## 2. P1 数据层：队列表与租约（`0260` migration + RunRepository）

**读什么**
- `packages/database/migrations/0260_run_lease.sql`：
  - `lease_until timestamptz` / `claimed_by text` / `request_payload jsonb` 三列（`ADD COLUMN IF NOT EXISTS`，幂等）。
  - `runs_queue_idx` 是**部分索引**（`WHERE status='queued'`），worker 轮询只扫 queued 行，跳过海量终态行——这是生产队列的常见优化。
  - 每张列都有 `COMMENT ON COLUMN` 中文注释（符合数据库规则）。
- `packages/database/src/run-repository.ts`
  - `CreateRunInputV2.requestPayload`（`run-repository.ts:23`）+ `create()` 写入 `request_payload`（`run-repository.ts:99`）：**把完整创建请求存进 DB**，worker claim 后据此重建执行上下文，无需跨进程传 request。
  - `claimNext`（`run-repository.ts:245`）：`select ... where status='queued' ... for update skip locked limit 1` 原子选取并锁行，再 `update ... status='running', lease_until=..., claimed_by=...`。`SKIP LOCKED` 让并发 worker 跳过已被锁的行、无竞争。
  - `renewLease`（`run-repository.ts:274`）：`where claimed_by=$2 and status='running' and lease_until > now()`——只有持有者且未过期才续期，返回 `boolean` 告知 caller 租约是否还在。
  - `release`（`run-repository.ts:290`）：把 running 重置为 queued（worker 主动放弃/异常退出）。
- `apps/api/src/application/run-ports.ts`
  - `ClaimedRun`（`run-ports.ts:7`）：worker 领取到的 `{ snapshot, request, userId }` 上下文。
  - `RunStore` 端口新增 `claimNext` / `renewLease` / `release`（`run-ports.ts:41-52`），PG 与内存实现都遵循同一契约。

**pi 对应物**：pi-agent 的 durable queue 范式（PG advisory lock / `FOR UPDATE SKIP LOCKED` + lease + 状态机）是这套设计的事实来源；本实现把"run 请求快照"显式落 `request_payload`，对齐 pi 把 job payload 持久化的做法。

**零回归纪律**
- `claimNext` 在同一事务内"选 + 锁 + 改状态"，避免两个 worker 抢到同一 run（经典双写 race）。
- 内存实现（`apps/api/src/adapters/in-memory-run-runtime.ts:105`）语义对齐 PG：单进程无并发，直接遍历首个 queued 并原子 claim。测试（`agent-run.test.mjs`）即走内存实现，端到端验证"创建→worker claim→执行→终态"。

**学习检查点**
- 为什么 `request_payload` 要单独一列而不是塞进已有的 jsonb？`runs` 表没有通用 payload 列；把"重放执行所需的请求"作为一等列，schema 自解释、索引/审计都方便。
- `SKIP LOCKED` 的语义：`select ... for update skip locked` 跳过已被其他事务锁住的行而不阻塞——这是"一个 run 只被一个 worker 执行"的物理保证，比 `select` 后应用层 CAS 更稳。

---

## 3. P1 执行层：worker loop 与 run-service 改造

**读什么**
- `apps/api/src/application/run-worker.ts`
  - `createRunWorker`（`run-worker.ts:54`）：依赖注入 `store` / `execute` / `workerId` / 轮询与租约参数。
  - `pollOnce`（`run-worker.ts:70`）：`busy` 守卫（`run-worker.ts:72`）保证单 worker **串行**执行（天然维持 per-conversation 串行，避免历史交错）；claim 成功后起 `renewLease` 续期定时器（`run-worker.ts:87`），执行体包裹为 Promise 供 `stop()` 等待。
  - `start()`（`run-worker.ts:109`）：立即 poll 一次 + `setInterval` 周期性 poll（默认 500ms，首 run 延迟低）。
  - `stop()`（`run-worker.ts:117`）：停轮询 + 有限等待（5s）当前 run 收尾，避免 shutdown 卡死。
- `apps/api/src/application/run-service.ts`
  - `create()`（`run-service.ts:468` 起）：**不再 `scheduler.schedule`**——只 `store.create`(queued) + `executionRegistry.create`(供 cancel 用) + `publish`(queued 事件)，立即返回 202。
  - `execute` 提升为对外方法（`run-service.ts:130` 接口声明、`run-service.ts:200` 实现、`run-service.ts:520` 返回）：worker 通过它执行，从 `request_payload` 重建上下文。
  - 删除项：`enqueueConversationRun`（per-conversation 串行链）与 `RunScheduler` 端口/`createMicrotaskRunScheduler`——worker 串行已覆盖其职责，**避免死代码**。
- `apps/api/src/index.ts`（组合根）
  - worker 装配（`index.ts:177-191`）：`workerId: randomUUID()` 标记 lease 归属；`onReady` 先 `recoverStale` 再 `runWorker.start()`；`onClose` 调 `runWorker.stop()`。

**pi 对应物**：pi 的 job worker 也是"poll claim → 续期 → 执行 → 释放"的闭环；本实现把 execute 复用 run-service 的同一函数（与 pi 复用 loop 执行体一致）。

**零回归纪律**
- `create()` 保留 `executionRegistry.create(runId)`：cancel 仍可经 AbortController 中断 queued/running 的 run（`run-service.ts:524`）。
- 集成测试 `apps/api/test/agent-run.test.mjs` 全部通过：worker 经 `onReady` 启动后异步消费队列，`waitForTerminal` 轮询快照直到终态——验证"HTTP 立即返回 + 后台执行"成立。

**学习检查点**
- 为什么不把 `execute` 直接放进 worker 文件？保持 run-service 是"用例边界"（创建/取消/执行/恢复），worker 只负责"何时调度执行"，职责单一；`execute` 经接口暴露也方便测试注入。
- `busy` 守卫 vs `SKIP LOCKED`：单 worker 时靠 `busy` 保证串行；多 worker 时靠 `SKIP LOCKED` 保证同一 run 不被两 worker 抢。两者互补，是分布式任务调度的标准组合。

---

## 4. P1 崩溃恢复：recoverStale 的语义演进

**读什么**
- `packages/database/src/run-repository.ts` 的 `recoverStale`（`run-repository.ts:202`）：
  - **步骤1**：`update runs set status='queued', lease_until=null, claimed_by=null where status='running' and lease_until < now()`——把"租约过期的 running"重置为 queued，让 worker 重新 claim（这就是 at-least-once 的恢复点）。
  - **步骤2**：`queued` 且 `updated_at < before` 的 run（长时间无人消费）→ 补 `run_status=interrupted` 事件，作为可解释终态。
- `apps/api/src/index.ts:188`：`onReady` 启动 worker 前先跑一次 `recoverStale`，把重启前遗留的 run 重排进队列。

**pi 对应物**：pi 的 stale-job 恢复（lease 过期 → 重排）直接对应；区别是本实现额外区分"短暂运行中被打断（重置 queued 重试）"与"长期无人消费（interrupted）"两种陈旧。

**学习检查点**
- at-least-once 的代价：一个 run 可能被执行两次（worker A 崩溃、lease 过期、worker B 重排执行，而 A 其实已接近完成）。本学习项目未做幂等去重（消息落库按 run_id 投影，重复执行会多落一批消息）。生产需引入"执行端幂等键"或"终态后再 claim 才允许重跑"等机制——这是时可主动点出的 tradeoff。
- 为什么 `interrupted` 而不是默默删除？Agent 产品必须对用户可见"这次研究没跑完"，而不是静默丢失任务。

---

## 5. P2 SSE 背压：从"能流式"到"扛得住流式"

**读什么**
- `apps/api/src/application/ordered-run-event-stream.ts`
  - `write(event): boolean`（`ordered-run-event-stream.ts:26`）：返回 `true` 表示可继续写，`false` 表示下游缓冲已满（背压信号）。
  - `drainContinuous`（`ordered-run-event-stream.ts:70`）：连续发送水位后事件；`if (!canContinue) return;`（`ordered-run-event-stream.ts:82`）在 `write` 返回 false 时暂停 drain。
  - `resume()`（`ordered-run-event-stream.ts:121`）：背压解除后由调用方触发，从暂停点继续 `drainContinuous`。
  - 设计前提（`ordered-run-event-stream.ts:11` 注释）：核心动作是"按 sequence 重排 + 间隙缓冲"，背压只是叠加在它之上的暂停/恢复旋钮。
- `apps/api/src/http/routes/runs.ts`（SSE 端点）
  - `write(event)` 回调（`runs.ts:137`）：`return reply.raw.write(...)`——把 Node HTTP 的背压布尔透传给流。
  - `reply.raw.on("drain", () => { stream.resume(); })`（`runs.ts:150`）：下游 socket 排空（`drain` 事件）时恢复推送。
  - 15s 心跳（`runs.ts:132`）与 `writeHead` SSE 头（`runs.ts:123`）保持不变。

**pi 对应物**：pi 的 SSE/stream 也已用 `write()` 返回值做背压；本实现把同一范式收敛到 `ordered-run-event-stream` 这一抽象层，使"重排"与"背压"正交。

**零回归纪律**
- 背压只是"暂停 drain"，不丢事件：`drainContinuous` 用 `pending` Map 缓冲间隙，恢复后从 `lastSequence+1` 继续——与 `Last-Event-ID` 重放机制共享同一套有序语义。
- 端到端测试 `apps/api/test/ordered-run-event-stream.test.mjs` 新增"write 返回 false 时暂停、resume 后补齐"的断言，守护背压不破坏有序性。
- 跨实例 fan-out 仍未做（eventBus 内存）：单实例 demo 足够；生产需 Redis pub/sub 或共享 replay 存储，列为 P2 待办（见 `05-engineering-deployment.md` P2 标注）。

**学习检查点**
- 为什么必须检查 `write()` 返回值？Node 的 `socket.write()` 在内部缓冲达 `highWaterMark` 时返回 `false`；若不暂停继续写，缓冲无限增长 → 内存膨胀甚至 OOM。返回 `false` 即"背压"，应停写等 `drain`。
- 背压 vs 反压（back-pressure）在流式系统里的位置：这是所有流式管道（Kafka consumer、WebSocket、gRPC stream）的通用概念；能讲清"write 返回 false → 暂停 → drain → 恢复"就掌握了流式背压的最小闭环。
- 为什么 SSE 不用 WebSocket？SSE 是单向 server→client、基于 HTTP、天然支持断线重连与 `Last-Event-ID`，对"事件推送"语义比 WebSocket 轻；代价是需自行实现背压（WebSocket 有帧级流控）。

---

