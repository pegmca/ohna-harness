/**
 * Trace 观测台（`/trace`）：左会话 → 中 run 列表 → 右事件流，`llm_call` 为一等公民。
 *
 * 数据来源全部是 serve 既有 run-v2 端点（D9）：
 * - `GET /api/conversations`（复用 conversation-client）；
 * - `GET /api/conversations/:id/runs`（本次新增的只读索引）；
 * - `GET /api/runs/:id/events`（终态 run 走 replayRunEvents，运行中走 followRunEvents 续传）。
 *
 * CLI 镜像 run（mode=observe）不写会话消息，因此本页是它们唯一的可视化入口。
 */
import type { ConversationDto, RunMetaDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkbenchNav } from "../../app/workbench-nav";
import { getRunSnapshot, listConversations } from "../../shared/api/conversation-client";
import { followRunEvents, replayRunEvents } from "../../shared/api/run-stream-client";
import { TraceStream } from "./TraceStream";
import { listConversationRuns } from "./trace-client";
import { projectTraceRows, type TraceTerminalRow } from "./trace-projection";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** 侧栏终态兜底条（follow 以 agent_end 结束时，随后的 run_status 会被丢弃）。 */
interface TerminalFallback {
  status: string;
  message?: string;
}

/**
 * 渲染 Trace 观测台。
 *
 * @returns 三栏观测页。
 */
export function TracePage() {
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [runs, setRuns] = useState<RunMetaDtoV2[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [events, setEvents] = useState<RunStreamEventDtoV2[]>([]);
  const [terminalFallback, setTerminalFallback] = useState<TerminalFallback>();
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [error, setError] = useState<string>();
  const streamController = useRef<AbortController | undefined>(undefined);
  /** 事件镜像：follow 返回后的终态判定需要读取「当前已收到的事件」，避免闭包快照过期。 */
  const eventsRef = useRef<RunStreamEventDtoV2[]>([]);

  const activeRun = useMemo(
    () => runs.find((run) => run.runId === activeRunId),
    [runs, activeRunId]
  );

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

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await listConversations(undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setConversations(response.data.items);
        setActiveConversationId((current) => current || response.data.items[0]?.conversationId || "");
      } catch {
        // 网络失败（fetch reject）：给出可读错误态，而不是空白页（S4-①）。
        if (!controller.signal.aborted) setError("加载会话列表失败，请确认本地服务仍在运行。");
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!activeConversationId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await listConversationRuns(activeConversationId, controller.signal);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setError(response.error.message);
          setRuns([]);
          return;
        }
        setError(undefined);
        setRuns(response.data);
        setActiveRunId((current) =>
          response.data.some((run) => run.runId === current) ? current : response.data[0]?.runId ?? ""
        );
      } catch {
        if (!controller.signal.aborted) {
          setError("加载 run 列表失败，请稍后重试。");
          setRuns([]);
        }
      }
    })();
    return () => controller.abort();
  }, [activeConversationId]);

  useEffect(() => {
    streamController.current?.abort();
    setEvents([]);
    eventsRef.current = [];
    setTerminalFallback(undefined);
    if (!activeRunId) return;

    const controller = new AbortController();
    streamController.current = controller;
    setIsLoadingEvents(true);
    const onEvent = (event: RunStreamEventDtoV2): void => {
      setEvents((previous) => {
        // 续传/重放可能重复投递同一 sequence：按序号去重并保持升序（S4-③）。
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
        // 事件流失败不遮蔽页面：终态兜底与外层错误态各自负责。
      } finally {
        if (controller.signal.aborted) return;
        setIsLoadingEvents(false);
        // 终态后刷新列表，让左栏状态与 trace 内容一致。
        const refreshed = await listConversationRuns(activeConversationId, controller.signal).catch(() => undefined);
        if (controller.signal.aborted || !refreshed?.ok) return;
        setRuns(refreshed.data);

        // S2：followRunEvents 以 agent_end 结束、会丢掉随后的 run_status；若事件里没有终态行，
        // 用快照合成一条，避免实时跟随结束后看不到「completed / failed」。
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
        if (controller.signal.aborted) return;
        setTerminalFallback({
          status: latest.status,
          message: snapshot?.ok ? snapshot.data.error?.message : undefined
        });
      }
    })();

    return () => controller.abort();
    // runs 只用于取当前 run 的初始状态；后续刷新不应重开事件流。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, activeConversationId]);

  return (
    <div className="trace-shell">
      <header className="trace-header">
        <div>
          <p className="md-label">ohna · 观测台</p>
          <h1 className="trace-title">Trace</h1>
        </div>
        <WorkbenchNav active="trace" />
      </header>

      <div className="trace-body">
        <aside className="trace-pane trace-conversations" aria-label="会话列表">
          <p className="md-label">会话</p>
          {conversations.length === 0 ? <p className="muted-row">暂无会话</p> : null}
          {conversations.map((conversation) => (
            <button
              className={`trace-list-item ${conversation.conversationId === activeConversationId ? "is-active" : ""}`}
              key={conversation.conversationId}
              onClick={() => setActiveConversationId(conversation.conversationId)}
              type="button"
            >
              <span className="trace-item-title">{conversation.title}</span>
              <span className="trace-item-meta">{conversation.conversationId.slice(0, 8)}</span>
            </button>
          ))}
        </aside>

        <section className="trace-pane trace-runs" aria-label="Run 列表">
          <p className="md-label">Runs</p>
          {error ? <p className="error-block">{error}</p> : null}
          {runs.length === 0 && !error ? <p className="muted-row">该会话暂无 run</p> : null}
          {runs.map((run) => (
            <button
              className={`trace-list-item ${run.runId === activeRunId ? "is-active" : ""}`}
              key={run.runId}
              onClick={() => setActiveRunId(run.runId)}
              type="button"
            >
              <span className="trace-item-title">
                <span className={`md-badge ${run.status === "failed" ? "md-badge-danger" : run.status === "running" ? "md-badge-info" : "md-badge-success"}`}>
                  {run.status}
                </span>
                <span className="md-badge">{run.mode}</span>
                {run.source === "cli" ? <span className="md-badge">CLI</span> : null}
              </span>
              <span className="trace-item-meta">{run.mode} · {run.source}</span>
              <span className="trace-item-meta">{run.runId.slice(0, 8)}</span>
              <span className="trace-item-meta">{run.createdAt}</span>
              {run.requestId ? <span className="trace-item-meta">{run.requestId}</span> : null}
            </button>
          ))}
        </section>

        <section className="trace-pane trace-main" aria-label="事件流">
          {activeRun ? (
            <header className="trace-run-header">
              <div>
                <p className="md-label">{activeRun.mode} · {activeRun.source}</p>
                <h2>{activeRun.runId}</h2>
              </div>
              <div className="trace-run-meta">
                <span>model: {activeRun.modelId}</span>
                <span>requestId: {activeRun.requestId}</span>
              </div>
            </header>
          ) : null}
          <TraceStream isLoading={isLoadingEvents} rows={rows} />
          <p className="trace-footnote">
            CLI 会话（默认 `ohna`）只镜像 run 事件，不写入对话消息；对话页不展示其内容，请在此观测。
            实时帧为原文；刷新后 replay 经模式级脱敏（邮箱 / 手机号显示为 [redacted:*]）。
          </p>
        </section>
      </div>
    </div>
  );
}
