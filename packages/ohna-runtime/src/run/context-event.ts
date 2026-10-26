/**
 * run 事件流里的上下文事件（docs/v2.0/04 §3，缺口 3：compaction-only）。
 *
 * 为什么发射点在编排层而不是内核：`compaction-enforce.ts` 是纯函数（输入 messages、
 * 输出 result），没有 sink、没有 run 上下文——保持纯净、不加重载。真正的会话级压缩发生在
 * `RunManager.createRun` 的 `compactHistoryForRun`（L3-3），`tokensBefore/After` 就在其返回值里。
 *
 * 本模块只负责「审计数据 → 线格式 payload」这一步纯投影；sequence 分配、落盘、广播仍归
 * `RunManager.emitFrame`（单一出口，本模块不感知 run 状态）。
 */
import type { ContextEventPayloadDto } from "@aiagent/types";

/** 触发压缩的会话级审计数据（`compactConversationHistory` 的返回值子集）。 */
export interface CompactionAudit {
  compacted: boolean;
  /** 压缩前双基准估算 token。 */
  tokensBefore: number;
  /** 压缩后双基准估算 token。 */
  tokensAfter: number;
  /** 压缩后历史里保留的消息条数（含压缩摘要自身）。 */
  retainedMessages: number;
  /** 持久化的压缩摘要文本（未持久化时为 undefined）。 */
  summary?: string;
}

/**
 * 把一次真实发生的压缩投影为 `context_event` payload。
 *
 * 未压缩（`compacted !== true`）一律返回 undefined：事件只代表「上下文结构确实变了」，
 * 「估算过了但没超窗」不构成事件（否则 Trace 的 Context Events 面板会被噪声填满）。
 *
 * `detail` 是可读说明（摘要长度 + 保留轮数 + 硬收敛条数），消费侧不解析它做逻辑判断，
 * 因此措辞调整不构成契约变更；需要机器可读量时用 `tokensBefore/tokensAfter`。
 *
 * @param audit 压缩审计数据。
 * @returns 事件 payload；未压缩时为 undefined。
 */
export function toContextEventPayload(
  audit: CompactionAudit,
): ContextEventPayloadDto | undefined {
  if (!audit.compacted) return undefined;
  const parts = [
    audit.summary !== undefined ? `摘要 ${audit.summary.length} 字` : "无持久化摘要",
    `保留 ${audit.retainedMessages} 条消息`,
    `净回收 ${Math.max(0, audit.tokensBefore - audit.tokensAfter)} token`,
  ];
  return {
    kind: "compaction",
    tokensBefore: audit.tokensBefore,
    tokensAfter: audit.tokensAfter,
    detail: parts.join(" · "),
  };
}
