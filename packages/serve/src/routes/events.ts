/**
 * Run 事件 SSE：`event: run_event` + `id: <sequence>` + run-v2 envelope JSON。
 *
 * 迁移期（Task 11）将 replay + live 的合并逻辑收敛进 `OhnaRuntime.subscribeRun`：
 * 路由只负责把 runtime 逐个回调的 canonical run event 按既有 SSE 帧格式写出，
 * 并在收到终态（`run_error` 或终态 `run_status`）时关闭连接。`agent_end` 不是
 * 关闭条件——run 在其后还会追加 `run_status` 终态帧，提前关闭会漏掉它。
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
 * 把单个 run event 写成一帧 SSE：`id: <seq>\nevent: run_event\ndata: <json>\n\n`。
 *
 * @param raw 底层 socket。
 * @param event canonical run event。
 */
function writeFrame(raw: NodeJS.WritableStream, event: RunStreamEventDtoV2): void {
  raw.write(`id: ${event.sequence}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`);
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

      let closed = false;
      let unsubscribe: () => void = () => undefined;
      const timers: { heartbeat?: NodeJS.Timeout } = {};

      /** 结束 SSE：清理心跳、退订并关闭底层 socket（幂等）。 */
      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      };

      // runtime 已按 afterSequence 合并 replay/live 并逐个按 sequence 升序回调 onEvent；
      // 顺序由 subscribeWithReplay 保证，这里直接写出即可，无需自管 replay 缓冲。
      const subscription = await deps.runtime.subscribeRun(request.params.runId, {
        afterSequence,
        onEvent: (event) => {
          if (closed || reply.raw.writableEnded) return;
          writeFrame(reply.raw, event);
          if (isTerminalEvent(event)) finish();
        }
      });
      unsubscribe = () => subscription.unsubscribe();

      request.raw.on("close", finish);

      if (closed) return;

      // 安全网：run 不存在直接关闭；终态帧统一由 onEvent 的 run_status 驱动关闭
      // （runtime 保证每个 run 都发射终态帧，故无需在快照终态时提前 finish）。
      const snapshot = await deps.runtime.getRunSnapshot(request.params.runId);
      if (!snapshot) {
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
