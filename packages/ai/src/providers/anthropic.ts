/**
 * Anthropic Messages provider 类型桩：形状与 ProviderStreams 一致，调用即产生结构化
 * error 事件（协议实现留待后续阶段启用，见 docs/worktree/07-migration-plan.md 风险 2）。
 */
import type { ProviderStreams } from "../types.js";
import { createDisabledProviderStreams } from "./disabled.js";

const streams: ProviderStreams = createDisabledProviderStreams("anthropic-messages");

/** Anthropic 协议的 stream 桩（未启用，立即产出 error 事件）。 */
export const stream: ProviderStreams["stream"] = streams.stream;

/** Anthropic 协议的 streamSimple 桩（未启用，立即产出 error 事件）。 */
export const streamSimple: ProviderStreams["streamSimple"] = streams.streamSimple;
