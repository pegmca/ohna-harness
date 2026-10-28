import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { BatchSummary, DraftSummary } from "../shared/api/types.js";
import { useApiClient } from "./context.js";

/** 异步资源的三种渲染状态。 */
type AsyncState<TData> =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; data: TData };

/**
 * 批次列表工作区。
 *
 * @returns 批次列表面板。
 */
export function BatchListPage() {
  const client = useApiClient();
  const [state, setState] = useState<AsyncState<BatchSummary[]>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    client
      .listBatches({ signal: controller.signal })
      .then((batches) =>
        setState(batches.length === 0 ? { status: "empty" } : { status: "ready", data: batches })
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unknown request failure."
        });
      });
    return () => controller.abort();
  }, [client]);

  return (
    <section className="workspace">
      <h2 className="page-title">Batches</h2>
      <AsyncStateView emptyLabel="No batches yet" loadingLabel="Loading batches" state={state}>
        {(batches) => (
          <ul className="row-list">
            {batches.map((batch) => (
              <li className="row-item" key={batch.name}>
                <span className="row-title">{batch.name}</span>
                <span className="row-meta">{batch.draftCount} drafts</span>
              </li>
            ))}
          </ul>
        )}
      </AsyncStateView>
    </section>
  );
}

/**
 * 单批次草稿列表工作区。
 *
 * @returns 草稿列表面板。
 */
export function BatchDraftsPage() {
  const client = useApiClient();
  const { batch = "" } = useParams();
  const [state, setState] = useState<AsyncState<DraftSummary[]>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    client
      .listDrafts(batch, { signal: controller.signal })
      .then((drafts) =>
        setState(drafts.length === 0 ? { status: "empty" } : { status: "ready", data: drafts })
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unknown request failure."
        });
      });
    return () => controller.abort();
  }, [batch, client]);

  return (
    <section className="workspace">
      <h2 className="page-title">{batch}</h2>
      <AsyncStateView emptyLabel="No drafts yet" loadingLabel="Loading drafts" state={state}>
        {(drafts) => (
          <ul className="row-list">
            {drafts.map((draft) => (
              <li className="row-item" key={draft.id}>
                <span className="row-title">{draft.query || draft.id}</span>
                <span className="row-meta">{draft.id}</span>
              </li>
            ))}
          </ul>
        )}
      </AsyncStateView>
    </section>
  );
}

/**
 * 通用异步状态渲染器，保持主区域 loading/empty/error 形状一致。
 *
 * @param props 状态对象、文案与 ready 内容渲染函数。
 * @returns 面板内容。
 */
function AsyncStateView<TData>(props: {
  state: AsyncState<TData>;
  loadingLabel: string;
  emptyLabel: string;
  children: (data: TData) => React.ReactNode;
}) {
  const { state, loadingLabel, emptyLabel, children } = props;
  if (state.status === "loading") return <p className="empty-state">{loadingLabel}</p>;
  if (state.status === "empty") return <p className="empty-state">{emptyLabel}</p>;
  if (state.status === "error") {
    return (
      <div className="error-state" role="alert">
        <p className="error-title">Request failed</p>
        <p className="error-message">{state.message}</p>
      </div>
    );
  }
  return children(state.data);
}
