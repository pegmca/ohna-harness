/**
 * run 级 traced StreamFn 的两个小工厂（docs/v2.0/04 §1.1 / §1.2 / §3.2）。
 *
 * 抽出来的唯一目的：让「window 在构造时注入」与「observer 在调用入口补齐」这两条
 * 冻结契约各有**一个**实现点，可被单测直接断言，避免 serve 侧出现第二套构造顺序。
 *
 * 不含任何状态机：本模块是纯函数工厂，`callIndex` / 记录组装全在
 * `@aiagent/agent` 的 `createLlmTraceStreamFn` 内（单一采集口径）。
 */
import { createLlmTraceStreamFn, markTracedStreamFn } from "@aiagent/agent";
import type { StreamFn } from "@aiagent/agent";
import type { LlmCallRecordDto, LlmWindowDto } from "@aiagent/types";

/**
 * 构造带采集标记的 traced wrapper（window 在**构造时**注入，§1.1）。
 *
 * `window.reserveTokens` 的唯一算法是 `resolveCompactionSettings(contextWindow).reserveTokens`
 * ——与 run 前压缩共用同一函数；计算在调用方（RunManager.createRun）完成并原样传入，
 * 本函数不做任何回落或补算。
 *
 * @param base 底层 StreamFn。
 * @param sink 采集记录出口（同步契约；拒绝被吞掉）。
 * @param window 窗口参数（contextWindow / maxTokens / reserveTokens）。
 * @returns 带 `isTracedStreamFn` 标记的 StreamFn。
 */
export function createRunTracedStreamFn(
  base: StreamFn,
  sink: (record: LlmCallRecordDto) => void,
  window: LlmWindowDto,
): StreamFn {
  return createLlmTraceStreamFn(base, sink, undefined, { window });
}

/**
 * 主线程 loop 用的 StreamFn：在 traced wrapper 外**薄转发**补 `observer.agentId`。
 *
 * 为什么 observer 写在外层：`createLlmTraceStreamFn` 在**调用入口**读取
 * `options.observer`（同步 throw 的错误记录同样要归因），因此必须在进入 wrapper 前写好。
 * 这里不新建 wrapper、不重新采集，`callIndex` 仍由同一 wrapper 计数（S1）。
 *
 * @param traced 已带采集标记的 StreamFn（`createRunTracedStreamFn` 的产物）。
 * @param agentId 发起方身份（主线程恒为 `SUPERVISOR_AGENT_ID`）。
 * @returns 已带采集标记的 StreamFn（同一 wrapper 外的薄转发器）。
 */
export function createSupervisorLoopStreamFn(traced: StreamFn, agentId: string): StreamFn {
  const forwarding: StreamFn = (model, context, options) =>
    traced(model, context, { ...options, observer: { ...options?.observer, agentId } });
  return markTracedStreamFn(forwarding);
}
