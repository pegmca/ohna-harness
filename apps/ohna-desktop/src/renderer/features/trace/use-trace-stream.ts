/**
 * Trace 事件流数据编排（03 D3）：把一个会话的 run 列表 + 选中 run 的事件流抽成 hook，
 * 供右侧 `TraceDrawer` 消费（原 `TracePage` 的三栏编排退役删除）。
 *
 * 数据来源全部是 serve 既有 run-v2 端点，不新增传输协议：
 * - `GET /api/conversations/:id/runs`（只读 run 索引）；
 * - `GET /api/runs/:id/events`（终态 run 走 replayRunEvents，运行中走 followRunEvents 续传）。
 *
 * v2.0（docs/v2.0/04 §5.4）两处改造：
 * - **增量归并**：sequence 单调递增时免 sort 直接 append；重复投递保持引用不变；
 *   只有真正的乱序回填才走二分插入归并（`event-stream-merge.ts`）。
 * - **memo 化**：rows / spans / contextPoints / contextEvents 全部 `useMemo` 依赖 `events` 引用，
 *   append 复用上一帧的事件数组时下游投影直接命中缓存。
 *
 * 竞态处理：会话切换 / run 切换 / 抽屉卸载都通过 AbortController 中断上一轮请求，
 * 并且每次切换递增代次号，避免迟到的响应把旧会话（或旧 run）的数据写回新视图。
 *
 * 对外契约只增不减：v1.4 的 `runs / activeRunId / activeRunMeta / rows / isLoading / error /
 * selectRun` 全部保留，新增 `events / traceSpans / contextPoints / contextEvents / isLive`。
 */
import type { ContextEventPayloadDto, RunMetaDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRunSnapshot } from "../../shared/sdk/ohna-client";
import { followRunEvents, replayRunEvents } from "../../shared/sdk/ohna-client";
import { mergeEvent, sortBySequence } from "./event-stream-merge";
import { listConversationRuns } from "./trace-client";
import {
  buildContextEventEntries,
  buildContextPoints,
  type ContextEventEntry,
  type ContextPoint
} from "./trace-context";
import { projectTraceRows, type TraceRow, type TraceTerminalRow } from "./trace-projection";
import { SUPERVISOR_AGENT_ID } from "./trace-labels";
import { buildTraceSpans, type TraceSpans } from "./trace-spans";

/** 终态 run 状态机值：命中时走 replay（读完即结束），否则走 follow（续传直到终态）。 */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** 终态兜底条（follow 以 agent_end 结束时，随后的 run_status 会被丢弃）。 */
interface TerminalFallback {
  /** 终态状态机值。 */
  status: string;
  /** 失败文案（来自快照）。 */
  message?: string;
}

/** `useTraceStream` 的返回值契约（v1.4 最小面 + 抽屉头部需要的选中 run 摘要 + v2.0 投影）。 */
export interface TraceStreamState {
  /** 当前会话下的 run 摘要（服务端按创建时间倒序）。 */
  runs: RunMetaDtoV2[];
  /** 当前选中的 run；空串表示尚未选中（无 run / 尚未加载完）。 */
  activeRunId: string;
  /** 选中 run 的摘要；undefined 表示尚未选中。 */
  activeRunMeta: RunMetaDtoV2 | undefined;
  /** 投影后可直接渲染的事件行（含终态兜底行）。 */
  rows: TraceRow[];
  /** 归一化后的事件流（按 sequence 升序；供执行地图/上下文面板派生）。 */
  events: RunStreamEventDtoV2[];
  /** Agent 森林 + Turn 跨度（执行地图）。 */
  traceSpans: TraceSpans;
  /** 每次 LLM 请求的上下文快照（Trend / Composition）。 */
  contextPoints: ContextPoint[];
  /** 上下文事件日志（Events）。 */
  contextEvents: ContextEventPayloadDto[];
  /** 上下文事件条目（带 sequence 锚点，Trend 的 ✂ 定位用）。 */
  contextEventEntries: ContextEventEntry[];
  /** 选中 run 是否仍在运行（live 指示器 / "● running" 的唯一判据）。 */
  isLive: boolean;
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
 * @returns run 列表、选中 run、投影行/跨度/上下文数据与加载/错误状态。
 */
export function useTraceStream(
  conversationId: string | undefined,
  enabled = true
): TraceStreamState {
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
    // 收尾逻辑抽到后面的 `settle()` 闭包后，上面 `if (!activeRunId || !conversationId ...)` 的
    // 类型窄化不会跨函数边界传递，因此在进入闭包前先固化成局部常量（行为与原来逐字等价）。
    const conversation = conversationId;
    const onEvent = (event: RunStreamEventDtoV2): void => {
      setEvents((previous) => {
        // 增量归并：单调递增免 sort；重复投递返回原引用（下游 memo 命中）；乱序才二分插入（S4-③ / §5.4）。
        const result = mergeEvent(previous, event);
        eventsRef.current = result.events as RunStreamEventDtoV2[];
        return result.events === previous ? previous : (result.events as RunStreamEventDtoV2[]);
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
      }
      // 收尾逻辑**不能写在 finally 里**：里面有 await 与早退 return，`no-unsafe-finally`
      // 标记的正是「finally 中的 return/await 会吞掉 try 块抛出的异常」——此处虽已 catch，
      // 但保持「finally 只做幂等清理」这一全局口径，未来给 try 加回 throw 才不会变成静默吞错。
      await settle();
    })();

    /**
     * 事件流结束后的收尾：装载态、乱序重排、run 列表刷新、终态兜底横条。
     *
     * 每一步都以 `aborted / generation` 判据早退：ref 重挂或切 run 后不得把旧结果写回。
     *
     * @returns 收尾完成的 Promise（异常不外抛——收尾失败不该盖住已有的错误态）。
     */
    async function settle(): Promise<void> {
      if (controller.signal.aborted || generation.current !== current) return;
      setIsLoading(false);
      // replay 是一次性装载：允许乱序，这里统一重排一次（live 的 append 快路径不受影响）。
      setEvents((previous) => {
        const sorted = sortBySequence(previous);
        eventsRef.current = sorted;
        return sorted;
      });
      // 终态后刷新列表，让 run 选择器的状态与 trace 内容一致。
      const refreshed = await listConversationRuns(conversation, controller.signal).catch(() => undefined);
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
        agentId: SUPERVISOR_AGENT_ID,
        status: terminalFallback.status,
        message: terminalFallback.message
      };
      return [...base, fallbackRow];
    }
    return base;
  }, [events, terminalFallback]);

  const traceSpans = useMemo(() => buildTraceSpans(events), [events]);
  const contextPoints = useMemo(() => buildContextPoints(events), [events]);
  const contextEventEntries = useMemo(() => buildContextEventEntries(events), [events]);
  const contextEvents = useMemo(
    () => contextEventEntries.map((entry) => entry.payload),
    [contextEventEntries]
  );
  const isLive = activeRun?.status === "running" || activeRun?.status === "queued";

  const selectRun = useCallback((runId: string): void => {
    setActiveRunId(runId);
  }, []);

  return {
    runs,
    activeRunId,
    activeRunMeta,
    rows,
    events,
    traceSpans,
    contextPoints,
    contextEvents,
    contextEventEntries,
    isLive,
    isLoading,
    error,
    selectRun
  };
}
