import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  X
} from "lucide-react";
import type {
  GoldenStudioAction,
  GoldenStudioActionName,
  GoldenStudioActionResult
} from "../../shared/api/types.ts";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import {
  ACTION_RUNNING_LABELS,
  actionConfirmation,
  actionErrorMessage,
  actionSuccessMessage
} from "./action-messages.ts";

/** 动作栏当前状态。 */
type ActionState =
  | { status: "idle" }
  | { status: "running"; action: GoldenStudioActionName }
  | { status: "success"; action: GoldenStudioActionName; message: string }
  | { status: "error"; action: GoldenStudioActionName; message: string };

/** 动作栏属性。 */
export interface ActionBarProps {
  /** 当前可用动作及其服务端载荷。 */
  actions: GoldenStudioAction[];
  /** 服务端数据客户端。 */
  client: Pick<GoldenStudioClient, "runAction">;
  /** 动作成功后刷新所属页面的 server 数据。 */
  onCompleted?: (
    action: GoldenStudioAction,
    result: GoldenStudioActionResult
  ) => void | Promise<void>;
  /** 可选的动作栏标题。 */
  label?: string;
}

/**
 * 执行 server 动作并提供确认、进度、成功与错误反馈。
 *
 * @param props 动作、回调与可选标题。
 * @returns 操作栏及模态确认框。
 */
export function ActionBar({
  actions,
  client,
  onCompleted,
  label = "Actions"
}: ActionBarProps) {
  const [requested, setRequested] = useState<GoldenStudioAction>();
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!requested) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && state.status !== "running") {
        closeConfirmation();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requested, state.status]);

  /**
   * 打开确认框并保存焦点归还目标。
   *
   * @param action 待确认动作。
   */
  const requestConfirmation = (action: GoldenStudioAction): void => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setRequested(action);
  };

  /**
   * 关闭确认框并把焦点归还给触发按钮。
   */
  const closeConfirmation = (): void => {
    setRequested(undefined);
    window.requestAnimationFrame(() => restoreFocusRef.current?.focus());
  };

  /**
   * 在确认后执行动作，并把 server 结果或异常映射为可见状态。
   *
   * @param action 已确认动作。
   */
  const execute = async (action: GoldenStudioAction): Promise<void> => {
    setRequested(undefined);
    setState({ status: "running", action: action.action });
    try {
      const result = await client.runAction(action.action, action.payload);
      setState({
        status: "success",
        action: action.action,
        message: actionSuccessMessage(action.action, result)
      });
      await onCompleted?.(action, result);
    } catch (error) {
      setState({
        status: "error",
        action: action.action,
        message: actionErrorMessage(error)
      });
    }
  };

  const running = state.status === "running";
  const confirmation = requested ? actionConfirmation(requested) : undefined;
  return (
    <section className="action-bar" aria-label={label}>
      <div className="action-buttons">
        {actions.map((action) => (
          <button
            className="button button-secondary"
            disabled={running}
            key={`${action.action}:${action.label}`}
            onClick={() => requestConfirmation(action)}
            type="button"
          >
            {running && state.action === action.action ? (
              <LoaderCircle aria-hidden="true" className="spin" size={15} />
            ) : null}
            {running && state.action === action.action
              ? ACTION_RUNNING_LABELS[action.action]
              : action.label}
          </button>
        ))}
      </div>
      <div aria-live="polite" className="action-feedback">
        {state.status === "success" ? (
          <p className="action-message action-message-success">
            <CheckCircle2 aria-hidden="true" size={14} />
            {state.message}
          </p>
        ) : null}
        {state.status === "error" ? (
          <p className="action-message action-message-error" role="alert">
            <AlertTriangle aria-hidden="true" size={14} />
            {state.message}
          </p>
        ) : null}
      </div>
      {requested && confirmation ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            aria-labelledby="action-confirm-title"
            aria-modal="true"
            className="confirm-dialog"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="confirm-dialog-heading">
              <div>
                <p className="eyebrow">Confirm action</p>
                <h2 id="action-confirm-title">{confirmation.title}</h2>
              </div>
              <button
                aria-label="Close confirmation"
                className="icon-button"
                onClick={closeConfirmation}
                type="button"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
            <p className="muted-text">{confirmation.description}</p>
            <div className="confirm-dialog-actions">
              <button
                className="button button-ghost"
                onClick={closeConfirmation}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={() => void execute(requested)}
                type="button"
              >
                {confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
