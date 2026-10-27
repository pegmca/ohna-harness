/**
 * Trace 观测台的固定文案常量与纯格式化函数（不依赖 React，可独立单测）。
 *
 * 为什么集中在一处：`SUPERVISOR_AGENT_ID` 是归属语义的唯一定义（未打标的行属于它，而不是
 * 走降级分支），`CONTEXT_ESTIMATE_NOTE` 是三个上下文面板共享的口径脚注——分散书写必然漂移
 * 成两三套说法（docs/v2.0/04 §1.4「口径统一」的显式要求）。
 */
import type { LlmCompositionDto } from "@aiagent/types";

/**
 * supervisor 根节点 agentId（与 `@aiagent/agent` 的 `SUPERVISOR_AGENT_ID` 同值）。
 *
 * web 是浏览器包，不依赖 `@aiagent/agent`（AGENTS.md：ohna-web 只依赖 `@aiagent/types`），
 * 因此这个值为字面量。用途是**归属语义**：事件 payload / `llm_call` 未打标时，该行属于
 * supervisor 根节点（docs/v2.0/04 §2.3），而不是对缺失形状的降级分支。
 */
export const SUPERVISOR_AGENT_ID = "supervisor";

/**
 * supervisor 根节点的展示身份（事件流尚未给出 `agent_start` 的 label 时作为兜底描述）。
 *
 * 只是展示文案：归属判定的唯一常量是 `SUPERVISOR_AGENT_ID`。
 */
export const SUPERVISOR_AGENT = {
  agentId: SUPERVISOR_AGENT_ID,
  label: "supervisor",
  role: "主线程"
} as const;

/**
 * 把 run 状态映射到既有徽标配色（不新增视觉语言）。
 *
 * @param status run 状态机值。
 * @returns 徽标 class。
 */
export function runStatusBadgeClass(status: string): string {
  if (status === "failed" || status === "interrupted") return "md-badge-danger";
  if (status === "running" || status === "queued") return "md-badge-info";
  return "md-badge-success";
}

/**
 * 三面板共享的估算口径脚注（只写一份，`ContextComposition` / `ContextTrend` /
 * `ContextEvents` 三处原样引用）。
 *
 * 文案方向必须写「低估」：`chars ÷ 4` 假定 ASCII 主导，而 CJK 字符每字约占 1 token
 * 甚至更多、中文密度更高，因此这一口径对中文内容会**低估** token 数（docs/v2.0/04 §1.4
 * 系数表把方向写反了，该文档缺陷由收尾任务统一修正；UI 文案以物理事实为准）。
 */
export const CONTEXT_ESTIMATE_NOTE =
  "口径：上下文构成按「字符数 ÷ 4」分块估算（ASCII 主导假设），用于比较各类占比；" +
  "CJK 字符每字约占 1 token 甚至更多，该口径会低估中文内容的 token 数。" +
  "实际用量以 provider 回报的 input / output 为准，二者不强行对齐。";

/** 估算口径标签（面板标题右侧的小字）。 */
export const CONTEXT_ESTIMATE_LABEL = "估算 · chars÷4";

/** 上下文面板的四个分类色槽（固定顺序，堆叠条与图例一致）。 */
export const COMPOSITION_SEGMENTS = [
  { key: "system", label: "system 系统提示词" },
  { key: "tools", label: "tools 工具 schema" },
  { key: "user", label: "user 用户消息" },
  { key: "assistant", label: "assistant 历史回复" },
  { key: "toolResult", label: "toolResult 工具结果" }
] as const;

/** 分类槽键。 */
export type CompositionKey = (typeof COMPOSITION_SEGMENTS)[number]["key"];

/**
 * 千分位格式化（中文区域设置）；非有限数回退 0。
 *
 * @param value 数值。
 * @returns 形如 `128,000` 的字符串。
 */
export function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "0";
}

/**
 * 把比例格式化为一位小数百分比（0 与极小值都显示 0.0%）。
 *
 * @param value 分子。
 * @param total 分母。
 * @returns 形如 `12.5%` 的字符串；分母非正时返回 `—`。
 */
export function formatPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  return `${((value / total) * 100).toFixed(1)}%`;
}

/**
 * 毫秒耗时格式化。
 *
 * @param ms 耗时（毫秒）；undefined 视为未知。
 * @returns 形如 `1234ms` / `2.4s` / `—` 的字符串。
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 带符号的 token 增量（compaction 净回收为负）。
 *
 * @param delta 增量（正表示增加）。
 * @returns 形如 `+1,200` / `-38,000` 的字符串。
 */
export function formatDelta(delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}${formatNumber(Math.abs(delta))}`;
}

/**
 * 取五分类中某一槽的数值（类型安全的索引助手）。
 *
 * @param composition 采集层已算好的五分类。
 * @param key 槽键。
 * @returns 该槽的估算 token 数。
 */
export function compositionValue(composition: LlmCompositionDto, key: CompositionKey): number {
  return composition[key];
}

/**
 * 把 token 数换算为相对满窗 contextWindow 的宽度百分比。
 *
 * 单条 100% 宽度 = `contextWindow`，尾部两个 hatch 段分别是压缩预留与输出预算，
 * 因此在正常情况下五分类 + 两段掩码合计不超过 100%——这正是「还剩多少可写」的可视化语义。
 * 超窗（历史数据或估算偏差）时调用方负责截断到 100%，图例仍展示真实数字。
 *
 * @param value token 数。
 * @param contextWindow 满窗 token 数。
 * @returns 百分比（0–100 之外不做截断）。
 */
export function tokenPercent(value: number, contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return (value / contextWindow) * 100;
}
