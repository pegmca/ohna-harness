/**
 * 待确认卡片的纯展示组件（W-4）：工具名 + summary + 关键参数，
 * allow / deny 双按钮；提交中禁用并显示「提交中」；失败展示结构化错误；
 * 已决卡片只读徽标（已允许 / 已拒绝），不可再点。
 */
import { Check, ShieldAlert, X } from "lucide-react";
import { keyParamOfArgs, type ConfirmationCard, type ConfirmationDecision } from "./confirmations";

/** 单张卡片的交互状态（由 Workbench 壳持有，组件保持纯展示）。 */
export interface ConfirmationCardUiState {
  /** 提交进行中的 decision；undefined 表示空闲。 */
  submitting?: ConfirmationDecision;
  /** 该卡片提交失败的结构化错误文案。 */
  error?: string;
}

interface ConfirmationCardsProps {
  cards: ConfirmationCard[];
  uiState: Record<string, ConfirmationCardUiState>;
  onDecide: (card: ConfirmationCard, decision: ConfirmationDecision) => void;
}

/**
 * 渲染待确认 / 已决卡片列表；无卡片时渲染 null（不占布局）。
 *
 * @param props 卡片与交互状态。
 * @returns 卡片列表。
 */
export function ConfirmationCards(props: ConfirmationCardsProps) {
  if (props.cards.length === 0) return null;
  return (
    <div aria-label="待确认操作" className="confirmation-cards" role="region">
      {props.cards.map((card) => (
        <ConfirmationCardView
          card={card}
          key={card.toolCallId}
          ui={props.uiState[card.toolCallId] ?? {}}
          onDecide={props.onDecide}
        />
      ))}
    </div>
  );
}

/**
 * 渲染单张确认卡片。
 *
 * @param props 卡片、交互状态与回调。
 * @returns 确认卡片。
 */
function ConfirmationCardView(props: {
  card: ConfirmationCard;
  ui: ConfirmationCardUiState;
  onDecide: (card: ConfirmationCard, decision: ConfirmationDecision) => void;
}) {
  const { card, ui } = props;
  const keyParam = keyParamOfArgs(card.args);
  const isSubmitting = ui.submitting !== undefined;
  const isPending = card.status === "pending";

  return (
    <article className={`confirmation-card is-${card.status}`}>
      <div className="confirmation-card-head">
        <ShieldAlert className="icon-size" aria-hidden="true" />
        <strong>{card.toolName}</strong>
        <span className="confirmation-summary">{card.summary}</span>
        {card.status === "allowed" ? <StatusChip label="已允许" tone="success" /> : null}
        {card.status === "denied" ? <StatusChip label="已拒绝" tone="danger" /> : null}
      </div>
      {keyParam ? <pre className="confirmation-param"><code>{keyParam}</code></pre> : null}
      {ui.error ? <p className="confirmation-error" role="status">{ui.error}</p> : null}
      {isPending ? (
        <div className="confirmation-actions">
          <button
            className="primary-action"
            disabled={isSubmitting}
            onClick={() => props.onDecide(card, "allow")}
            type="button"
          >
            <Check className="icon-size" />
            {ui.submitting === "allow" ? "提交中" : "允许"}
          </button>
          <button
            className="danger-action"
            disabled={isSubmitting}
            onClick={() => props.onDecide(card, "deny")}
            type="button"
          >
            <X className="icon-size" />
            {ui.submitting === "deny" ? "提交中" : "拒绝"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * 已决态徽标。
 *
 * @param props 文案与色调。
 * @returns 状态徽标。
 */
function StatusChip(props: { label: string; tone: "success" | "danger" }) {
  return (
    <span className={`status-badge tone-${props.tone}`}>
      {props.tone === "success" ? <Check className="icon-size" /> : <X className="icon-size" />}
      {props.label}
    </span>
  );
}
