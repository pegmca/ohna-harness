/**
 * team 评测的轨迹 / 用量投影（docs/v2.0/03-team-eval.md §7 的「证据源 → 指标」一段）。
 *
 * 职责边界（与 eval-core 的分工，对齐 `packages/eval-core/src/trajectory.ts` 文件头）：
 * - **投影归 app**：把 `RunEvent[]`（生产形态，`payload` 为 `unknown`）或 `AgentEvent[]`
 *   （子代理 agentLoop 的形态）投影成中性结构，不进内核；
 * - **匹配归内核**：`matchTrajectory` 只做「期望 vs 实际」匹配，不感知来源。
 *
 * 本模块只做投影与纯计算，零 IO、零模型调用，因此可确定性单测（T-L1/T-L2 的证据层）。
 * 与 coding 的 `run.ts::collectEvents` 的区别：coding 只看工具轨迹与轮数，team 还要把
 * `cost_summary.team` 段拆成「每成员用量」与「团队累计」，供 tokenAttributionToMember /
 * costAmplificationRatio 消费。
 */

import { matchTrajectory, type ToolCallStep } from "@aiagent/eval-core";
import type { TeamEvalCase } from "./types.js";

/** 生产 run 事件的最小结构（`RunEvent` 的结构子集，避免 app 强依赖 trace 包运行时）。 */
export interface TeamRunEventLike {
  /** 事件类型（`RunEventType`）。 */
  type: string;
  /** 事件负载（`tool_execution_*` 为 unknown，按字段探针读取）。 */
  payload?: unknown;
}

/** 从 run 事件投影出的 team 派发步骤（§7 的 `TeamDispatchStep[]`）。 */
export interface TeamDispatchStep {
  /** 工具名（TeamCreate / SendMessage / 其它）。 */
  tool: string;
  /** 工具调用入参（探针读取到的对象快照）。 */
  args: Record<string, unknown>;
  /** 工具调用是否以错误结束。 */
  isError: boolean;
}

/**
 * 从任意 payload 中探针读取字段（`RunEvent.payload` 是 `unknown`，必须防御式解构）。
 *
 * @param payload 待探测的负载。
 * @param key 字段名。
 * @returns 字段值；payload 非对象或字段缺失返回 undefined。
 */
function probe(payload: unknown, key: string): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

/**
 * 把生产 `RunEvent[]` 投影成 `TeamDispatchStep[]`（只保留编排原语调用）。
 *
 * 投影规则：`tool_execution_start` 携带 toolName/args，`tool_execution_end` 携带
 * `isError`；按 toolCallId 配对（与 agent 的 AgentEvent 同语义）。只保留 `toolNames`
 * 中的工具（默认 TeamCreate / SendMessage），使派发轨迹不被子代理内部工具噪音淹没。
 *
 * @param events 生产 run 事件序列（顺序即为事件发生顺序）。
 * @param toolNames 需要保留的工具名集合（缺省为两个编排原语）。
 * @returns 派发步骤列表（顺序与事件顺序一致）。
 */
export function projectDispatchSteps(
  events: readonly TeamRunEventLike[],
  toolNames: readonly string[] = ["TeamCreate", "SendMessage"],
): TeamDispatchStep[] {
  const wanted = new Set(toolNames);
  const pending = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const steps: TeamDispatchStep[] = [];

  for (const event of events) {
    if (event.type === "tool_execution_start") {
      const tool = String(probe(event.payload, "toolName") ?? "");
      if (!wanted.has(tool)) continue;
      const id = String(probe(event.payload, "toolCallId") ?? "");
      const args = probe(event.payload, "args");
      pending.set(id, { tool, args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {} });
    } else if (event.type === "tool_execution_end") {
      const id = String(probe(event.payload, "toolCallId") ?? "");
      const started = pending.get(id);
      if (!started) continue;
      pending.delete(id);
      steps.push({ tool: started.tool, args: started.args, isError: probe(event.payload, "isError") === true });
    }
  }

  return steps;
}

/**
 * 把派发步骤投影为「派发序列」（recipient + content），供 dispatchCorrectness 对齐。
 *
 * @param steps 派发步骤（`projectDispatchSteps` 产物或直接注入的等价结构）。
 * @returns 派发序列（只含 SendMessage 语义的步骤：有 recipient 字段）。
 */
export function projectSends(steps: readonly TeamDispatchStep[]): Array<{ recipient: string; content: string }> {
  const sends: Array<{ recipient: string; content: string }> = [];
  for (const step of steps) {
    const recipient = step.args.recipient;
    if (typeof recipient !== "string") continue;
    sends.push({ recipient, content: String(step.args.content ?? "") });
  }
  return sends;
}

/**
 * 把 `cost_summary.team` 段投影成「每成员用量」表。
 *
 * 语义差异提醒（§9.1.4）：`projectTeamCostSummary` 输出**所有成员**（含 0 用量），
 * 因此本函数会把 0 用量成员也带进来——这是可观测完整性的要求，
 * `teamTokenAttributionToMember` 只用它做归因一致性校验，不因 0 用量误判。
 *
 * @param team `cost_summary.payload.team` 段（结构见 `@aiagent/trace` 契约）。
 * @returns 成员名 → 用量；段缺失或非法时返回空对象。
 */
/**
 * 把 unknown 探针值收敛成非负数字（非法一律 0）。
 *
 * 接受：有限数字、可完整解析的十进制字符串（`/^-?\d+(\.\d+)?$/`）。
 * 拒绝（归 0）：NaN / Infinity / 空串 / 布尔 / 对象 / 带杂质的字符串（如 `"1.2abc"`）。
 *
 * @param value 待收敛的探针值。
 * @returns 非负有限数字（非法输入返回 0）。
 */
function toNonNegativeNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

/**
 * 从 team 状态投影「每成员用量」（token 归因的证据源）。
 *
 * 非法/缺失值按 0 处理（见 `toNonNegativeNumber` 的严格判定口径），不静默产生 NaN。
 *
 * @param team team 状态（`unknown`，内部结构化探针，不假设具体类）。
 * @returns 成员名 → `{ tokens, cost }`。
 */
export function projectTeamMemberUsage(
  team: unknown,
): Record<string, { tokens: number; cost: number }> {
  const usage: Record<string, { tokens: number; cost: number }> = {};
  const members = probe(team, "members");
  if (!Array.isArray(members)) return usage;
  for (const member of members) {
    const name = probe(member, "name");
    if (typeof name !== "string") continue;
    // 口径：只有「数字」或「可完整解析为数字的字符串」才被接受。
    // 不用 `Number(x)` 直接强转——`Number("1.2abc")` 是 NaN、`Number("")` 是 0、
    // `Number(true)` 是 1，这些都会把「非法数据」静默变成 0 或伪值，与该文件
    // 「非法即不适用」的诚实口径冲突。非法值一律归 0 并在该成员的字段上留痕不可行
    // （类型只允许 number），因此这里选择「显式判非法 → 归 0」，并在 JSDoc 写明。
    usage[name] = { tokens: toNonNegativeNumber(probe(member, "tokens")), cost: toNonNegativeNumber(probe(member, "cost")) };
  }
  return usage;
}

/**
 * 投影「实际工具调用轨迹」并与 case 的期望轨迹做匹配（趋势段用）。
 *
 * 匹配采用 subset（期望是实际的保序子序列），与 coding 的
 * `toolSelectionCorrectness` 同口径；差异在于 team 的期望轨迹只含编排原语。
 *
 * @param case_ 评测 case（取其 expectedToolCalls）。
 * @param actual 实际派发步骤。
 * @returns matched 与差异明细；无期望时返回 `matched: true` 且 `expected` 为空。
 */
export function matchExpectedDispatch(
  case_: Pick<TeamEvalCase, "expectedToolCalls">,
  actual: ReadonlyArray<{ tool: string; args?: Record<string, unknown>; isError?: boolean }>,
): ReturnType<typeof matchTrajectory> {
  const expected: ToolCallStep[] = (case_.expectedToolCalls ?? []).map((step) => ({
    tool: step.tool,
    ...(step.args ? { args: step.args } : {}),
  }));
  const actualSteps: ToolCallStep[] = actual.map((step) => ({
    tool: step.tool,
    ...(step.args ? { args: step.args } : {}),
    ...(step.isError !== undefined ? { isError: step.isError } : {}),
  }));
  return matchTrajectory(actualSteps, expected, "subset");
}

/**
 * 从 `cost_summary` 事件数组中取出**最后一个** team 段（趋势段汇总用）。
 *
 * 取最后一个的原因：一个 conversation 里可能有多次 run，收尾的 cost_summary 才是最完整的
 * 一次（前面的事件可能只覆盖了部分工具）。缺失时返回 undefined，由调用方显式 skip。
 *
 * @param events 生产 run 事件序列。
 * @returns team 段（unknown 原样返回，交给 `projectTeamMemberUsage` 探针解析）。
 */
export function lastTeamCostSection(events: readonly TeamRunEventLike[]): unknown {
  let last: unknown;
  for (const event of events) {
    if (event.type !== "cost_summary") continue;
    const team = probe(event.payload, "team");
    if (team !== undefined) last = team;
  }
  return last;
}
