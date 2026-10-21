/**
 * Trace 事件流数据编排（03 D3）：把一个会话的 run 列表 + 选中 run 的事件流抽成 hook，
 * 供右侧 `TraceDrawer` 消费（原 `TracePage` 的三栏编排退役删除）。
 *
 * 数据来源全部是 serve 既有 run-v2 端点，不新增传输协议：
 * - `GET /api/conversations/:id/runs`（只读 run 索引）；
 * - `GET /api/runs/:id/events`（终态 run 走 replayRunEvents，运行中走 followRunEvents 续传）。
 *
 * 竞态处理：会话切换 / run 切换 / 抽屉卸载都通过 AbortController 中断上一轮请求，
 * 并且每次切换递增代次号，避免迟到的响应把旧会话（或旧 run）的数据写回新视图。
 */
import type { RunMetaDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRunSnapshot } from "../../shared/api/conversation-client";
import { followRunEvents, replayRunEvents } from "../../shared/api/run-stream-client";
import { listConversationRuns } from "./trace-client";
import { projectTraceRows, type TraceRow, type TraceTerminalRow } from "./trace-projection";

/** 终态 run 状态机值：命中时走 replay（读完即结束），否则走 follow（续传直到终态）。 */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** 终态兜底条（follow 以 agent_end 结束时，随后的 run_status 会被丢弃）。 */
interface TerminalFallback {
  status: string;
  message?: string;
}

/** `useTraceStream` 的返回值契约（03 D3 约定的最小面 + 抽屉头部需要的选中 run 摘要）。 */
export interface TraceStreamState {
  /** 当前会话下的 run 摘要（服务端按创建时间倒序）。 */
  runs: RunMetaDtoV2[];
  /** 当前选中的 run；空串表示尚未选中（无 run / 尚未加载完）。 */
  activeRunId: string;
  /** 选中 run 的摘要；undefined 表示尚未选中。 */
  activeRunMeta: RunMetaDtoV2 | undefined;
  /** 投影后可直接渲染的事件行（含终态兜底行）。 */
  rows: TraceRow[];
  /** 事件流是否仍在加载（replay 尚未返回首帧）。 */
  isLoading: boolean;
  /** 结构化错误文案；undefined 表示无错误。 */
  error: string | undefined;
  /** 切换选中的 run。 */
  selectRun(runId: string): void;
}

/**
 * 订阅某会话的 run 列表与选中 run 的事件流。
 *
 * @param conversationId 当前会话 ID；undefined 表示没有选中会话（清空全部状态）。
 * @param enabled 抽屉是否展开；收起时不发任何请求，展开时再加载（默认 true）。
 * @returns run 列表、选中 run、投影行与加载/错误状态。
 */
export function useTraceStream(conversationId: string | undefined, enabled = true): TraceStreamState {
  const [runs, setRuns] = useState<RunMetaDtoV2[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [events, setEvents] = useState<RunStreamEventDtoV2[]>([]);
  const [terminalFallback, setTerminalFallback] = useState<TerminalFallback>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const streamController = useRef<AbortController | undefined>(undefined);
  /** 事件镜像：follow 返回后的终态判定要读「当前已收到的事件」，避免闭包快照过期。 */
  const eventsRef = useRef<RunStreamEventDtoV2[]>([]);
  /** 会话 + run 的代次号：切换后旧代次的迟到回调一律丢弃。 */
  const generation = useRef(0);

  const activeRun = useMemo(
    () => runs.find((run) => run.runId === activeRunId),
    [runs, activeRunId]
  );
  /** 选中 run 的摘要（画布头部展示 mode/source/modelId）；run 选择器本身直接渲染 runs。 */
  const activeRunMeta = activeRun;

  // 会话切换：清空上一会话的 run / 事件，并让在途请求失效。
  useEffect(() => {
    generation.current += 1;
    streamController.current?.abort();
    setRuns([]);
    setActiveRunId("");
    setEvents([]);
    eventsRef.current = [];
    setTerminalFallback(undefined);
    setError(undefined);
    setIsLoading(false);
    if (!conversationId || !enabled) return;

    const current = generation.current;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await listConversationRuns(conversationId, controller.signal);
        if (controller.signal.aborted || generation.current !== current) return;
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setRuns(response.data);
        setActiveRunId(response.data[0]?.runId ?? "");
      } catch {
        // 网络失败：给出可读错误态，不把异常抛给渲染层（S4-①）。
        if (!controller.signal.aborted && generation.current === current) {
          setError("加载 run 列表失败，请确认本地服务仍在运行。");
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, enabled]);

  // 选中 run 的事件流：reset → replay/follow → 刷新列表 → 终态兜底。
  useEffect(() => {
    streamController.current?.abort();
    setEvents([]);
    eventsRef.current = [];
    setTerminalFallback(undefined);
    if (!activeRunId || !conversationId || !enabled) {
      setIsLoading(false);
      return;
    }

    const current = generation.current;
    const controller = new AbortController();
    streamController.current = controller;
    setIsLoading(true);
    const onEvent = (event: RunStreamEventDtoV2): void => {
      setEvents((previous) => {
        // 续传 / 重放可能重复投递同一 sequence：按序号去重并保持升序（S4-③）。
        if (previous.some((item) => item.sequence === event.sequence)) {
          eventsRef.current = previous;
          return previous;
        }
        const next = [...previous, event].sort((left, right) => left.sequence - right.sequence);
        eventsRef.current = next;
        return next;
      });
    };

    void (async () => {
      const run = runs.find((item) => item.runId === activeRunId);
      try {
        if (run && TERMINAL_STATUSES.has(run.status)) {
          await replayRunEvents(activeRunId, { signal: controller.signal, onEvent });
        } else {
          await followRunEvents(activeRunId, { signal: controller.signal, onEvent });
        }
      } catch {
        // 事件流失败不遮蔽面板：终态兜底与外层错误态各自负责。
      } finally {
        if (controller.signal.aborted || generation.current !== current) return;
        setIsLoading(false);
        // 终态后刷新列表，让 run 选择器的状态与 trace 内容一致。
        const refreshed = await listConversationRuns(conversationId, controller.signal).catch(() => undefined);
        if (controller.signal.aborted || generation.current !== current || !refreshed?.ok) return;
        setRuns(refreshed.data);

        // S2：followRunEvents 以 agent_end 结束、会丢掉随后的 run_status；若事件里没有终态行，
        // 用快照合成一条，避免跟随结束后看不到「completed / failed」。
        const hasTerminalRow = eventsRef.current.some(
          (event) => event.type === "run_status" || event.type === "run_error"
        );
        const latest = refreshed.data.find((item) => item.runId === activeRunId);
        if (hasTerminalRow || !latest || !TERMINAL_STATUSES.has(latest.status)) return;
        // 取快照只为拿到失败文案：网络失败不影响终态横条本身。
        let snapshot: Awaited<ReturnType<typeof getRunSnapshot>> | undefined;
        try {
          snapshot = await getRunSnapshot(activeRunId, controller.signal);
        } catch {
          snapshot = undefined;
        }
        if (controller.signal.aborted || generation.current !== current) return;
        setTerminalFallback({
          status: latest.status,
          message: snapshot?.ok ? snapshot.data.error?.message : undefined
        });
      }
    })();

    return () => controller.abort();
    // runs 只用于取当前 run 的初始状态；后续刷新不应重开事件流。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, conversationId, enabled]);

  const rows = useMemo(() => {
    const base = projectTraceRows(events);
    if (terminalFallback && !base.some((row) => row.kind === "terminal")) {
      const fallbackRow: TraceTerminalRow = {
        kind: "terminal",
        key: "terminal-fallback",
        status: terminalFallback.status,
        message: terminalFallback.message
      };
      return [...base, fallbackRow];
    }
    return base;
  }, [events, terminalFallback]);

  const selectRun = useCallback((runId: string): void => {
    setActiveRunId(runId);
  }, []);

  return {
    runs,
    activeRunId,
    activeRunMeta,
    rows,
    isLoading,
    error,
    selectRun
  };
}
