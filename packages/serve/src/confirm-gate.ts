/**
 * 异步确认闸门（03 §6.3）：把 CLI 的同步 readline 确认改造成 Web 可用的 Promise 挂起。
 *
 * 生命周期：
 * 1. `agentLoop` 在工具执行前调用 `beforeToolCall`；
 * 2. 权限策略裁决为 ask 的 mutating 工具 → 通过 `emit` 广播并落盘
 *    `confirmation_requested`，然后返回一个**一直挂起**的 Promise；
 * 3. 浏览器 `POST /api/runs/:runId/confirmations/:toolCallId` 调 `resolve`：
 *    allow → 工具正常执行；deny → `{block:true}`，工具层回喂 isError；
 * 4. 超时 / run 取消 / run 结束都会自动 deny 并清理挂起项，避免泄漏。
 *
 * K1 单一事实源：工具是否进入确认不再由本文件维护名单，而是由 `AgentTool.effect`
 * 声明、`createPermissionGate` 统一裁决。本文件的职责收缩为「SSE AskAdapter +
 * Promise 挂起生命周期」；`autoApprove` 映射为 bypass 预设。
 *
 * 会话记忆边界：Web 端确认卡片当前只有允许 / 拒绝两个动作，没有「本会话一律允许」；
 * 因此 serve 侧 `PolicyState` 始终为空（仅保留接口一致性），会话记住目前仅 CLI 提供。
 */
import {
  createPermissionGate,
  createPolicyState,
  createPresetPolicy,
  type AskAdapter,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type PermissionPreset,
} from "@aiagent/agent";

/** 用户决定。 */
export type ConfirmationDecision = "allow" | "deny";

/** `confirmation_requested` 事件的 payload（已写入 `RunEventTypeDto`）。 */
export interface ConfirmationRequestedPayload {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** 面向 UI 的一句话摘要，避免前端自己猜参数语义。 */
  summary: string;
}

/** 待确认项：`reasonRef` 让超时 / 取消原因能穿透 AskAdapter 的 allow|deny 二值回答。 */
interface PendingConfirmation {
  runId: string;
  toolCallId: string;
  resolve: (answer: "allow" | "deny") => void;
  /** 拒绝原因槽：wrapper 在 gate 返回 block 后用它覆盖通用文案。 */
  reasonRef: { reason?: string };
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** `resolve` 的结构化结果；路由据此映射 404 / 409。 */
export type ResolveConfirmationResult =
  | { ok: true }
  | {
      ok: false;
      code: "not_found" | "conflict" | "auto_approve";
      message: string;
    };

/** 创建选项。 */
export interface AsyncConfirmGateOptions {
  /** `--auto-approve`：直接放行（映射为 bypass 预设），不产生任何确认事件。 */
  autoApprove: boolean;
  /** 等待上限（毫秒）；缺省 5 分钟。测试可注入很短的值。 */
  timeoutMs?: number;
  /**
   * 广播 + 落盘 `confirmation_requested`。
   * 由 serve 装配注入（RunManager 分配 sequence 后写入 runs JSONL 并推 SSE）。
   */
  emit: (runId: string, payload: ConfirmationRequestedPayload) => void | Promise<void>;
}

/** 默认确认等待时长：足够用户切回浏览器点一下，又不会让 run 永久悬挂。 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** bash 摘要在 UI 中的最大展示长度。 */
const COMMAND_SUMMARY_LIMIT = 80;

/** 超时自动拒绝原因（文案会作为 isError toolResult 回喂模型）。 */
const TIMEOUT_DENY_REASON = "确认超时，已自动拒绝该操作（未执行）。";

/** run 取消原因。 */
const ABORTED_REASON = "Run 已取消，操作未执行。";

/** 确认请求无法送达时的原因。 */
const EMIT_FAILED_REASON = "无法发送确认请求，操作已拒绝。";

/** 组合 key：同一 toolCallId 在不同 run 中可能重复。 */
function keyOf(runId: string, toolCallId: string): string {
  return `${runId}\u0000${toolCallId}`;
}

/**
 * 从工具参数生成人类可读摘要。
 *
 * 保留本函数（而非复用策略层摘要）是为了不改变既有前端卡片文案契约。
 *
 * @param toolName 工具名。
 * @param args 已通过 zod 校验的参数。
 * @returns `写文件 x` / `修改 x` / `执行命令 x` / `执行 tool`。
 */
export function summarizeToolCall(toolName: string, args: unknown): string {
  const record =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const pathText = typeof record.path === "string" && record.path.trim() !== "" ? record.path : "?";

  if (toolName === "write") return `写文件 ${pathText}`;
  if (toolName === "edit") return `修改 ${pathText}`;
  if (toolName === "bash") {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const short =
      command.length > COMMAND_SUMMARY_LIMIT
        ? `${command.slice(0, COMMAND_SUMMARY_LIMIT)}…`
        : command;
    return `执行命令 ${short || "?"}`;
  }
  return `执行 ${toolName}`;
}

/** 异步确认闸门。 */
export interface AsyncConfirmGate {
  /** 该 run 的 `beforeToolCall` 钩子。 */
  createHook(
    runId: string
  ): (
    context: BeforeToolCallContext,
    signal?: AbortSignal
  ) => Promise<BeforeToolCallResult | undefined>;
  /** 处理用户决定；幂等保护：未知 / 已决 toolCallId 返回结构化错误。 */
  resolve(
    runId: string,
    toolCallId: string,
    decision: ConfirmationDecision
  ): ResolveConfirmationResult;
  /** run 取消：所有挂起项立即 deny 释放。 */
  cancelRun(runId: string): void;
  /** run 结束 / shutdown：清理挂起与已决记录。 */
  clearRun(runId: string): void;
  /** 该 run 当前的待确认数量（诊断 / 测试）。 */
  pendingCount(runId: string): number;
  /** 是否处于自动批准模式。 */
  readonly autoApprove: boolean;
}

/**
 * 创建异步确认闸门。
 *
 * @param options 自动批准开关、超时与事件出口。
 * @returns 可被 RunManager 复用的闸门实例。
 */
export function createAsyncConfirmGate(options: AsyncConfirmGateOptions): AsyncConfirmGate {
  const autoApprove = options.autoApprove;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  /** autoApprove → bypass；否则 default（serve 暂无 UI 切换预设）。 */
  const preset: PermissionPreset = autoApprove ? "bypass" : "default";
  /** serve 暂不支持「本会话记住」，但仍共享同一 PermissionPolicy 接口。 */
  const state = createPolicyState();
  /** pending：key = runId + toolCallId。 */
  const pending = new Map<string, PendingConfirmation>();
  /** 已决记录：仅用于把「重复提交」与「从未请求」区分成 409 / 404。 */
  const decided = new Map<string, Set<string>>();

  /**
   * 标记已决（保留最近记录供重复提交判定）。
   *
   * @param runId run id。
   * @param toolCallId 工具调用 id。
   */
  const markDecided = (runId: string, toolCallId: string): void => {
    const set = decided.get(runId) ?? new Set<string>();
    set.add(toolCallId);
    decided.set(runId, set);
  };

  /**
   * 结束一个挂起项：清定时器、退订 abort、resolve 并删除。
   *
   * @param key 组合 key。
   * @param answer 交给权限闸门的二值回答。
   */
  const settle = (key: string, answer: "allow" | "deny"): void => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    markDecided(entry.runId, entry.toolCallId);
    entry.resolve(answer);
  };

  /**
   * 拒绝某个 run 的全部挂起项。
   *
   * @param runId run id。
   * @param reason 回喂模型的原因。
   */
  const denyRun = (runId: string, reason: string): void => {
    for (const [key, entry] of [...pending.entries()]) {
      if (entry.runId !== runId) continue;
      // 把精确原因写进槽位，wrapper 会在 gate 返回后覆盖通用拒绝文案。
      entry.reasonRef.reason = reason;
      settle(key, "deny");
    }
  };

  return {
    autoApprove,

    createHook(runId) {
      return async (context: BeforeToolCallContext, signal?: AbortSignal) => {
        const toolCallId = context.toolCall.id;
        /** 本次工具调用的拒绝原因（超时 / 取消 / 发送失败），按调用隔离避免并行串扰。 */
        const reasonRef: { reason?: string } = {};

        /**
         * SSE AskAdapter：登记 pending → 广播 → 等待浏览器决定。
         *
         * @param request 权限请求。
         * @param _decision 策略 ask 裁决（摘要本身由 serve 自有格式重算）。
         * @param askSignal run 级中断信号。
         * @returns 允许 / 拒绝。
         */
        const ask: AskAdapter = async (request, _decision, askSignal) => {
          if (askSignal?.aborted) {
            reasonRef.reason = ABORTED_REASON;
            return "deny";
          }

          const key = keyOf(runId, toolCallId);
          const payload: ConfirmationRequestedPayload = {
            toolCallId,
            toolName: request.toolName,
            args: request.args,
            summary: summarizeToolCall(request.toolName, request.args),
          };

          // 先登记 pending 再广播：用户可能在 SSE 帧到达的瞬间就点「允许」，
          // 若等 emit 返回后才登记，确认路由会短暂 404（竞态）。
          const waiting = new Promise<"allow" | "deny">((resolvePromise) => {
            const entry: PendingConfirmation = {
              runId,
              toolCallId,
              resolve: resolvePromise,
              reasonRef,
            };

            entry.timer = setTimeout(() => {
              reasonRef.reason = TIMEOUT_DENY_REASON;
              settle(key, "deny");
            }, timeoutMs);
            entry.timer.unref?.();

            if (askSignal) {
              entry.signal = askSignal;
              entry.onAbort = () => {
                reasonRef.reason = ABORTED_REASON;
                settle(key, "deny");
              };
              askSignal.addEventListener("abort", entry.onAbort, { once: true });
            }

            pending.set(key, entry);
          });

          try {
            // 落盘 + 广播：刷新后的 replay 一定能恢复这张卡片。
            await options.emit(runId, payload);
          } catch {
            // 无法把确认请求送达用户时，宁可拒绝也不静默执行副作用。
            reasonRef.reason = EMIT_FAILED_REASON;
            settle(key, "deny");
          }

          if (signal?.aborted) {
            reasonRef.reason = ABORTED_REASON;
            settle(key, "deny");
          }

          return await waiting;
        };

        // 每次工具调用新建 gate：AskAdapter 需要闭包捕获 toolCallId（并行工具调用互不串扰）。
        const gate = createPermissionGate(() => createPresetPolicy(preset), state, ask);
        const result = await gate(context, signal);

        // denyRun / 超时 / abort 的精确原因优先于 gate 的通用「用户拒绝」文案。
        if (result?.block && reasonRef.reason) {
          return { block: true, reason: reasonRef.reason };
        }
        return result;
      };
    },

    resolve(runId, toolCallId, decision) {
      if (autoApprove) {
        return {
          ok: false,
          code: "auto_approve",
          message: "已开启自动批准（--auto-approve），写/执行操作无需确认。",
        };
      }
      const key = keyOf(runId, toolCallId);
      if (!pending.has(key)) {
        if (decided.get(runId)?.has(toolCallId)) {
          return {
            ok: false,
            code: "conflict",
            message: "该工具调用已完成确认，无法重复提交。",
          };
        }
        return {
          ok: false,
          code: "not_found",
          message: "该工具调用没有待确认的操作。",
        };
      }
      // 用户手动拒绝不写 reasonRef，由 gate 生成「用户拒绝了该操作：<摘要>」。
      settle(key, decision === "allow" ? "allow" : "deny");
      return { ok: true };
    },

    cancelRun(runId) {
      denyRun(runId, ABORTED_REASON);
    },

    clearRun(runId) {
      denyRun(runId, "Run 已结束，操作未执行。");
      decided.delete(runId);
    },

    pendingCount(runId) {
      let count = 0;
      for (const entry of pending.values()) {
        if (entry.runId === runId) count += 1;
      }
      return count;
    },
  };
}
