/**
 * RunManager 与异步确认闸门之间的桥接层。
 *
 * 单独成文件的原因：确认语义（pending 生命周期 + 事件落盘）与 run 事件循环是
 * 两个内聚领域；拆开后 RunManager 只保留「转发」职责，避免单文件膨胀。
 */
import type { RunEventTypeDto } from "@aiagent/types";
import type {
  AsyncConfirmGate,
  ConfirmationDecision,
  ConfirmationRequestedPayload,
  ResolveConfirmationResult
} from "../confirm-gate.js";
import type { ActiveRun } from "./types.js";

/** 确认桥接器。 */
export class RunConfirmations {
  /**
   * @param gate 异步确认闸门（缺省时确认端点返回 not_found）。
   * @param getRun 按 runId 取活跃 run。
   * @param emitFrame 发出并持久化一条 run 事件。
   */
  constructor(
    private readonly gate: AsyncConfirmGate | undefined,
    private readonly getRun: (runId: string) => ActiveRun | undefined,
    private readonly emitFrame: (
      run: ActiveRun,
      type: RunEventTypeDto,
      payload: unknown
    ) => Promise<void>
  ) {}

  /**
   * 把「等待用户确认」落盘为 `confirmation_requested` 并广播。
   *
   * 该事件必须持久化：页面刷新后 SSE replay 才能恢复未决卡片。
   *
   * @param runId run id。
   * @param payload 工具调用摘要。
   * @throws run 不存在或已终态时抛出结构化错误（闸门会据此拒绝执行）。
   */
  async emitRequested(runId: string, payload: ConfirmationRequestedPayload): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.terminal) {
      throw Object.assign(new Error("Run 不存在或已结束，无法请求确认。"), {
        code: "run_not_active"
      });
    }
    await this.emitFrame(run, "confirmation_requested", payload);
  }

  /**
   * 提交用户决定（供 `POST /api/runs/:runId/confirmations/:toolCallId` 调用）。
   *
   * @param runId run id。
   * @param toolCallId 工具调用 id。
   * @param decision allow / deny。
   * @returns 结构化结果；未知 / 已决 / 自动批准由路由映射为 404 / 409。
   */
  resolve(runId: string, toolCallId: string, decision: ConfirmationDecision): ResolveConfirmationResult {
    if (!this.gate) {
      return { ok: false, code: "not_found", message: "当前服务未启用确认闸门。" };
    }
    return this.gate.resolve(runId, toolCallId, decision);
  }

  /**
   * 是否处于 `--auto-approve` 模式（路由用于给出更准确的 409 文案）。
   *
   * @returns 自动批准返回 true。
   */
  isAutoApprove(): boolean {
    return this.gate?.autoApprove ?? false;
  }

  /**
   * 某 run 当前待确认数量（诊断 / 测试）。
   *
   * @param runId run id。
   * @returns 待确认数量。
   */
  pendingCount(runId: string): number {
    return this.gate?.pendingCount(runId) ?? 0;
  }
}
