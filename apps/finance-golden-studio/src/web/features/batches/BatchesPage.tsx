import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, RefreshCw } from "lucide-react";
import { useOptionalApiClient } from "../../app/context.tsx";
import type {
  BatchSummary,
  GoldenStudioAction,
  GoldenStudioActionResult
} from "../../shared/api/types.ts";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import { ActionBar } from "../actions/ActionBar.tsx";

/** 批次数据加载状态。 */
type LoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; data: BatchSummary[] };

/** 批次页属性；客户端可注入以便组件测试。 */
export interface BatchesPageProps {
  /** 可选注入客户端；缺省读取 App 上下文。 */
  client?: GoldenStudioClient;
  /** 可选完成回调，供路由级缓存刷新。 */
  onChanged?: () => void;
}

/**
 * 批次工作区：显示审核进度、异常与发布入口。
 *
 * @param props 注入的客户端与完成回调。
 * @returns 批次表格或加载/空/错误状态。
 */
export function BatchesPage({ client: injected, onChanged }: BatchesPageProps = {}) {
  const client = useInjectedClient(injected);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) =>
      current.status === "ready" ? current : { status: "loading" }
    );
    client
      .listBatches({ signal: controller.signal })
      .then((batches) =>
        setState(
          batches.length === 0
            ? { status: "empty" }
            : { status: "ready", data: batches }
        )
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [client, refreshKey]);

  const refresh = useCallback((): void => {
    setRefreshKey((value) => value + 1);
  }, []);

  const completed = async (
    action: GoldenStudioAction,
    _result: GoldenStudioActionResult
  ): Promise<void> => {
    if (action.action !== "promote") return;
    refresh();
    onChanged?.();
  };

  return (
    <section className="workspace workspace-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Authoring</p>
          <h1 className="page-title">Batches</h1>
          <p className="page-subtitle">
            Review draft progress, resolve corrupt rows, and publish approved work.
          </p>
        </div>
        <button
          aria-label="Refresh batches"
          className="button button-secondary"
          onClick={refresh}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={15} />
          Refresh
        </button>
      </header>

      {state.status === "loading" ? (
        <p aria-live="polite" className="empty-state">
          Loading batches
        </p>
      ) : null}
      {state.status === "empty" ? (
        <div className="empty-state">
          <p>No draft batches yet.</p>
          <p className="muted-text">Mine candidates to create the first batch.</p>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="error-state" role="alert">
          <p className="error-title">Batches could not be loaded</p>
          <p className="error-message">{state.message}</p>
          <button className="button button-secondary" onClick={refresh} type="button">
            Try again
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <div className="table-shell">
          <table className="data-table batch-table">
            <caption className="sr-only">Draft batches and promotion status</caption>
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Approved</th>
                <th scope="col">Progress</th>
                <th scope="col">Attention</th>
                <th className="batch-actions-heading" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.map((batch) => (
                <BatchRow
                  batch={batch}
                  client={client}
                  key={batch.name}
                  onCompleted={completed}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 优先使用注入客户端；仅在路由组合根中读取上下文。
 *
 * @param injected 可选注入客户端。
 * @returns 数据客户端。
 */
function useInjectedClient(injected: GoldenStudioClient | undefined): GoldenStudioClient {
  const contextClient = useOptionalApiClient();
  const client = injected ?? contextClient;
  if (!client) throw new Error("BatchesPage requires an injected client or AppProvider.");
  return client;
}

/**
 * 渲染单个批次行、进度条及各自独立的 action bar。
 *
 * @param props 批次、客户端与完成回调。
 * @returns 表格行。
 */
function BatchRow({
  batch,
  client,
  onCompleted
}: {
  batch: BatchSummary;
  client: GoldenStudioClient;
  onCompleted: (
    action: GoldenStudioAction,
    result: GoldenStudioActionResult
  ) => Promise<void>;
}) {
  const approved = ratio(batch.approvedCount, batch.draftCount);
  const promotable =
    batch.corruptCount === 0 && batch.approvedCount > 0;
  const action = promotable
    ? [
        {
          action: "promote" as const,
          label: "Promote approved",
          payload: { batch: batch.name }
        }
      ]
    : [];
  return (
    <tr>
      <td data-label="Batch">
        <Link className="table-link" to={`/batch/${encodeURIComponent(batch.name)}`}>
          {batch.name}
        </Link>
        <span className="table-subline">{batch.draftCount} drafts</span>
      </td>
      <td data-label="Approved">
        <span className="table-number">
          {batch.approvedCount} / {batch.draftCount}
        </span>
        <span className="table-subline">{approved}%</span>
      </td>
      <td data-label="Progress">
        <div
          aria-label={`${approved}% approved`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={approved}
          className="progress-track"
          role="progressbar"
        >
          <span className="progress-value" style={{ width: `${approved}%` }} />
        </div>
        <span className="table-subline">
          {batch.pendingCount} pending
        </span>
      </td>
      <td data-label="Attention">
        {batch.corruptCount > 0 ? (
          <span className="status-line status-line-danger">
            <AlertTriangle aria-hidden="true" size={13} />
            {batch.corruptCount} corrupt
          </span>
        ) : batch.pendingCount > 0 ? (
          <span className="status-line status-line-warning">
            {batch.pendingCount} awaiting review
          </span>
        ) : (
          <span className="status-line status-line-success">Complete</span>
        )}
      </td>
      <td className="table-actions">
        <Link className="button button-ghost" to={`/batch/${encodeURIComponent(batch.name)}`}>
          Review drafts
          <ArrowRight aria-hidden="true" size={14} />
        </Link>
        {action.length > 0 ? (
          <ActionBar
            actions={action}
            client={client}
            label={`Actions for ${batch.name}`}
            onCompleted={onCompleted}
          />
        ) : null}
      </td>
    </tr>
  );
}

/**
 * 计算整数百分比并限制在 0–100。
 *
 * @param count 已完成数量。
 * @param total 总数量。
 * @returns 四舍五入百分比。
 */
function ratio(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((count / total) * 100)));
}

/**
 * 提取可展示错误。
 *
 * @param error 捕获值。
 * @returns 错误文本。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown request failure.";
}
