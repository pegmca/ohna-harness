/**
 * Run 事件 SSE：`event: run_event` + `id: <sequence>` + run-v2 envelope JSON。
 *
 * replay + live 的无缝衔接：
 * 1. 先订阅实时广播（只写入 buffer），避免 replay 查询期间的新事件丢失；
 * 2. 读取 JSONL 已落盘事件并入同一 buffer；
 * 3. replay 结束后按 sequence 排序统一 flush，再切换到实时 flush。
 *
 * 与 finance-api 的 `ordered-run-event-stream` 相比，这里允许 sequence 跳号：
 * `message_update` 是瞬态事件，不落盘但占序号，重连后不可能补齐；强连续会让 SSE 永久卡住。
 */
import type { RunStatusDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, failure, parseSequenceCursor } from "../errors.js";
import { isTerminalStatus } from "../run-manager.js";
import type { RouteDeps } from "./types.js";

/** SSE 心跳间隔（毫秒）。 */
const HEARTBEAT_MS = 15_000;

/**
 * 判断事件是否应关闭 SSE。
 *
 * `agent_end` **不是**关闭条件：服务端在它之后还会追加 sequence 更大的
 * `run_status` 终态帧；若在此关闭，replay 会漏掉 `run_status`，客户端永远
 * 看不到 completed，且 SSE 最大 id 会小于 `snapshot.lastEventSequence`。
 * `agent_end` 只作为普通帧投递。
 *
 * @param event canonical run event。
 * @returns run_error / 终态 run_status 返回 true。
 */
function isTerminalEvent(event: RunStreamEventDtoV2): boolean {
  if (event.type === "run_error") return true;
  if (event.type !== "run_status") return false;
  const payload = event.payload as { status?: string };
  return Boolean(payload.status && isTerminalStatus(payload.status as RunStatusDtoV2));
}

/**
 * 注册 `GET /api/runs/:runId/events`。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { runId: string }; Querystring: { afterSequence?: string } }>(
    "/api/runs/:runId/events",
    async (request, reply) => {
      const requestId = createRequestId();
      const rawAfterSequence = request.query.afterSequence;
      if (rawAfterSequence !== undefined && parseSequenceCursor(rawAfterSequence) === undefined) {
        return failure(reply, requestId, 400, "bad_request", "SSE replay 游标格式不正确。");
      }

      const snapshot = await deps.runManager.getSnapshot(request.params.runId);
      if (!snapshot) {
        return failure(reply, requestId, 404, "not_found", "Run 不存在。");
      }

      // afterSequence 与 Last-Event-ID 取大者：浏览器重连时两者都可能携带。
      const headerRaw = request.headers["last-event-id"];
      const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
      const headerSequence = headerValue ? Number(headerValue) : 0;
      const afterSequence = Math.max(
        parseSequenceCursor(rawAfterSequence) ?? 0,
        Number.isSafeInteger(headerSequence) && headerSequence >= 0 ? headerSequence : 0
      );

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });

      const pending = new Map<number, RunStreamEventDtoV2>();
      let lastSent = afterSequence;
      let replayDone = false;
      let closed = false;
      const timers: { heartbeat?: NodeJS.Timeout } = {};
      let unsubscribe = (): void => undefined;

      /** 结束 SSE：清理心跳、退订并关闭底层 socket（幂等）。 */
      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      };

      /**
       * 按 sequence 顺序写出 buffer 中尚未发送的事件。
       * sequence 允许跳号（message_update 不落盘），但不允许倒退。
       */
      const flush = (): void => {
        if (closed) return;
        const events = [...pending.values()]
          .filter((event) => event.sequence > lastSent)
          .sort((left, right) => left.sequence - right.sequence);
        for (const event of events) {
          pending.delete(event.sequence);
          lastSent = event.sequence;
          if (!reply.raw.writableEnded) {
            reply.raw.write(
              `id: ${event.sequence}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`
            );
          }
          if (isTerminalEvent(event)) {
            finish();
            return;
          }
        }
      };

      // 先订阅：replay 查询期间的 live 事件只进 buffer。
      unsubscribe = deps.runManager.subscribe(snapshot.runId, (event) => {
        if (closed) return;
        pending.set(event.sequence, event);
        if (replayDone) flush();
      });

      request.raw.on("close", finish);

      const replay = await deps.runStore.listEvents(snapshot.runId);
      for (const event of replay) {
        if (event.sequence > lastSent) pending.set(event.sequence, event);
      }
      replayDone = true;
      flush();

      if (closed) return;
      // 兜底：早期 JSONL 可能只有 agent_end 没有 run_status；快照已终态时 replay 完即关闭。
      // 正常路径会先由 flush 里的 run_status 终止，不会走到这里。
      if (isTerminalStatus(snapshot.status)) {
        finish();
        return;
      }

      timers.heartbeat = setInterval(() => {
        if (!closed && !reply.raw.writableEnded) reply.raw.write(": heartbeat\n\n");
      }, HEARTBEAT_MS);
    }
  );
}

/** 导出给测试 / 其他 transport 复用的关闭判定。 */
export { isTerminalEvent };
