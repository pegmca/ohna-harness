import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  FileClock,
  RefreshCw
} from "lucide-react";
import { useOptionalApiClient } from "../../app/context.tsx";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import type {
  GoldenStatus,
  GoldenStudioAction,
  GoldenStudioActionResult
} from "../../shared/api/types.ts";
import { ActionBar } from "../actions/ActionBar.tsx";

/** 作者集页面加载状态。 */
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GoldenStatus };

/** 作者集页属性；客户端可注入以便组件测试。 */
export interface GoldenPageProps {
  /** 可选注入客户端；缺省读取 App 上下文。 */
  client?: GoldenStudioClient;
}

/**
 * 作者集与生成评测产物的分离工作区。
 *
 * @param props 注入的客户端。
 * @returns 校验健康、生成健康与动作入口。
 */
export function GoldenPage({ client: injected }: GoldenPageProps = {}) {
  const client = useInjectedClient(injected);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    client
      .readGoldenStatus({ signal: controller.signal })
      .then((data) => setState({ status: "ready", data }))
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
    if (action.action === "validate" || action.action === "generate") refresh();
  };

  return (
    <section className="workspace workspace-wide">
      <header className="page-header">
        <div>
          <p className="eyebrow">Datasets</p>
          <h1 className="page-title">Golden</h1>
          <p className="page-subtitle">
            Authored cases remain the source of truth; generated eval data is a separate artifact.
          </p>
        </div>
        <button
          aria-label="Refresh golden status"
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
          Loading golden status
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="error-state" role="alert">
          <p className="error-title">Golden status could not be loaded</p>
          <p className="error-message">{state.message}</p>
          <button className="button button-secondary" onClick={refresh} type="button">
            Try again
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <>
          <ActionBar
            actions={goldenActions(state.data)}
            client={client}
            label="Golden actions"
            onCompleted={completed}
          />
          <div className="dataset-grid">
            <AuthoredPanel status={state.data} />
            <GeneratedPanel status={state.data} />
          </div>
        </>
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
  if (!client) throw new Error("GoldenPage requires an injected client or AppProvider.");
  return client;
}

/**
 * 构造作者集动作；生成必须由 current authored set 驱动。
 *
 * @param status server 返回的作者集与生成物状态。
 * @returns 可用于 action bar 的动作。
 */
function goldenActions(status: GoldenStatus): GoldenStudioAction[] {
  return [
    { action: "validate", label: "Validate authors", payload: { scope: "golden" } },
    { action: "generate", label: "Generate eval set" }
  ];
}

/**
 * 渲染作者集源文件与校验问题。
 *
 * @param props server 状态。
 * @returns 作者集区段。
 */
function AuthoredPanel({ status }: { status: GoldenStatus }) {
  const authored = status.authored;
  return (
    <section aria-label="Authored golden" className="dataset-panel">
      <div className="dataset-panel-header">
        <div>
          <p className="eyebrow">Source of truth</p>
          <h2>Authored golden</h2>
        </div>
        <span className="badge badge-neutral">JSONL</span>
      </div>
      <FileCheck2 aria-hidden="true" className="dataset-icon" size={18} />
      <p className="dataset-path">{authored.path}</p>
      <dl className="metric-row">
        <div>
          <dt>Cases</dt>
          <dd>{authored.caseCount} cases</dd>
        </div>
        <div>
          <dt>Validation</dt>
          <dd>
            {authored.validation.ok ? (
              <span className="status-line status-line-success">
                <CheckCircle2 aria-hidden="true" size={13} />
                Passed
              </span>
            ) : (
              <span className="status-line status-line-danger">
                <AlertTriangle aria-hidden="true" size={13} />
                Validation failed
              </span>
            )}
          </dd>
        </div>
      </dl>
      {authored.validation.errors.length > 0 ? (
        <div className="issue-summary">
          <h3>Validation issues</h3>
          <ul>
            {authored.validation.errors.slice(0, 5).map((issue, index) => (
              <li key={`${issue.code}:${issue.id ?? "record"}:${index}`}>
                <code>{issue.id ?? issue.code}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted-text">No validation issues reported.</p>
      )}
    </section>
  );
}

/**
 * 渲染生成评测产物的真实存在性与摘要。
 *
 * @param props server 状态。
 * @returns 生成物区段。
 */
function GeneratedPanel({ status }: { status: GoldenStatus }) {
  const generated = status.generated;
  return (
    <section aria-label="Generated eval artifact" className="dataset-panel">
      <div className="dataset-panel-header">
        <div>
          <p className="eyebrow">Derived artifact</p>
          <h2>Generated eval artifact</h2>
        </div>
        <span
          className={`badge ${generated.exists ? "badge-success" : "badge-warning"}`}
        >
          {generated.exists ? "Available" : "Not generated"}
        </span>
      </div>
      <FileClock aria-hidden="true" className="dataset-icon" size={18} />
      <p className="dataset-path">{generated.path}</p>
      {generated.exists ? (
        <dl className="metric-row">
          <div>
            <dt>Cases</dt>
            <dd>{generated.caseCount} cases</dd>
          </div>
          <div>
            <dt>Dataset version</dt>
            <dd>{generated.datasetVersion}</dd>
          </div>
          <div>
            <dt>Modified</dt>
            <dd>{formatTimestamp(generated.modifiedAt)}</dd>
          </div>
        </dl>
      ) : (
        <p className="empty-asset">
          Generate the eval set after authored validation passes.
        </p>
      )}
    </section>
  );
}

/**
 * 以用户本地时区格式化 server 时间戳。
 *
 * @param value ISO 时间。
 * @returns 本地日期与时间。
 */
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
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
