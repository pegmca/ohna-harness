/**
 * 工具轨迹匹配（v2.0 薄内核方案 §2.2 / §2.3 边界修正）：
 *
 * 内核**只做「匹配」，不做「从 run 事件投影轨迹」**——真实 `RunEvent` 的 `tool_execution_*`
 * 事件 `payload` 是 `unknown`，无法静态投影；投影（含 `extractToolTrajectory`）留各 app
 * 的 eval 域（`<app>/eval/run.ts` 把 run 事件投影成 `ToolCallStep[]`）。若内核以 `RunEvent[]`
 * 入参，会引入 `@aiagent/trace` 运行时依赖，违反「零 `@aiagent/*` 依赖」硬边界。
 *
 * 同样，「期望轨迹推导」（依赖金融 fixture / 业务语义）也不进内核：期望项也用 `ToolCallStep[]`
 * 表达（必填参数键从 `expected[i].args` 的键集推导），由调用方提供。内核只负责严格 / 子集
 * 匹配 + 参数级校验。纯函数、可独立单测。
 */

/** 单个工具调用步骤：由各 app 的 run 事件投影层产出，内核不关心其来源。 */
export interface ToolCallStep {
  /** 工具名（如 search_filings / edit / read）。 */
  tool: string;
  /** 该次调用的入参（键集用于参数级校验：期望项的 args 键集即必填参数）。 */
  args?: Record<string, unknown>;
  /**
   * 工具调用是否失败——工具检索 / few-shot「调用成败」评测需要。内核可空但须保留字段位。
   */
  isError?: boolean;
}

/** 轨迹匹配模式：strict 要求顺序且数量一致；subset 要求期望是实际轨迹的保序子序列。 */
export type TrajectoryMatchMode = "strict" | "subset";

/** 轨迹匹配结果：给出 matched 判定与差异明细，便于报告展示。 */
export interface TrajectoryMatch {
  /** 实际使用的匹配模式。 */
  mode: TrajectoryMatchMode;
  /** 是否匹配：缺失工具 / 多余工具 / 参数缺失任一项存在则为 false。 */
  matched: boolean;
  /** 期望工具名序列。 */
  expected: string[];
  /** 实际工具名序列。 */
  actual: string[];
  /** 期望中存在但实际缺失的工具名。 */
  missing: string[];
  /** 实际中存在但期望未要求的工具名（strict 模式下视为不匹配）。 */
  extra: string[];
  /** 同名工具调用中必填参数缺失的定位。 */
  paramMismatches: Array<{ tool: string; missingArgs: string[] }>;
}

/**
 * 对齐期望与实际工具名序列，返回每个期望工具对应的实际下标（未对齐为 -1）。
 * strict 要求长度与顺序完全一致；subset 用贪心保序子序列匹配。
 *
 * @param expectedNames 期望工具名序列。
 * @param actualNames 实际工具名序列。
 * @param mode 匹配模式。
 * @returns 与期望等长的下标数组，-1 表示该期望工具未对齐。
 */
function alignTrajectory(
  expectedNames: readonly string[],
  actualNames: readonly string[],
  mode: TrajectoryMatchMode,
): number[] {
  const align: number[] = [];
  if (mode === "strict") {
    // strict：长度不等则整体无法 1:1 对齐，全部标记为未对齐。
    if (expectedNames.length !== actualNames.length) {
      for (let i = 0; i < expectedNames.length; i += 1) align.push(-1);
      return align;
    }
    for (let i = 0; i < expectedNames.length; i += 1) {
      align.push(expectedNames[i] === actualNames[i] ? i : -1);
    }
    return align;
  }
  // subset：期望必须是实际轨迹的保序子序列。
  let cursor = 0;
  for (let i = 0; i < expectedNames.length; i += 1) {
    while (cursor < actualNames.length && actualNames[cursor] !== expectedNames[i]) cursor += 1;
    if (cursor >= actualNames.length) {
      align.push(-1);
    } else {
      align.push(cursor);
      cursor += 1;
    }
  }
  return align;
}

/**
 * 将期望轨迹与实际工具调用序列做匹配，输出 matched 判定与差异明细。
 *
 * 期望项与实际项**同为 `ToolCallStep[]`**（去掉对金融类型的依赖）；期望项中 `args` 的键集
 * 即该工具调用的「必填参数」，用于参数级校验。**参数顺序：先 `actual` 后 `expected`**，
 * 与 §2.2 契约一致。
 *
 * - strict：expected 工具名序列须与 actual **顺序且数量一致**；actual 多出记 extra，
 *   expected 多出记 missing。
 * - subset：expected 须是 actual 的**保序子序列**；多余工具不计入 extra 触发失败。
 * - 对匹配上的同名工具调用，校验期望项的 args 每个键是否出现在对应 actual step 的 `args`，
 *   缺失记入 `paramMismatches`。
 *
 * 综合判定：`matched = missing.length===0 && (mode==="subset" ? true : extra.length===0) && paramMismatches.length===0`。
 *
 * @param actual 实际工具调用序列（由 app 投影层产出）。
 * @param expected 期望轨迹（同为 ToolCallStep[]，args 键集即必填参数）。
 * @param mode 匹配模式。
 * @returns 匹配结果（matched + 差异明细）。 */
export function matchTrajectory(
  actual: readonly ToolCallStep[],
  expected: readonly ToolCallStep[],
  mode: TrajectoryMatchMode,
): TrajectoryMatch {
  const expectedNames = expected.map((item) => item.tool);
  const actualNames = actual.map((step) => step.tool);
  const align = alignTrajectory(expectedNames, actualNames, mode);

  // 缺失 / 多余按"工具名是否出现"判定（比位置更贴近语义：出现过的工具不算缺失）。
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const extra = actualNames.filter((name) => !expectedNames.includes(name));
  // 全部期望工具是否都成功对齐（strict 要求顺序一致，subset 要求保序子序列）。
  const alignedAll = align.every((index) => index >= 0);

  // 参数级校验：仅对成功对齐的同名工具调用，检查期望项的 args 键集是否都在实际 args 中。
  const paramMismatches: Array<{ tool: string; missingArgs: string[] }> = [];
  for (let i = 0; i < expected.length; i += 1) {
    const actualIndex = align[i];
    if (actualIndex < 0) continue;
    const requirement = expected[i];
    if (!requirement.args || Object.keys(requirement.args).length === 0) continue;
    const step = actual[actualIndex];
    const presentArgs = step.args ?? {};
    const missingArgs = Object.keys(requirement.args).filter((key) => !(key in presentArgs));
    if (missingArgs.length > 0) {
      paramMismatches.push({ tool: requirement.tool, missingArgs });
    }
  }

  const matched =
    alignedAll &&
    missing.length === 0 &&
    (mode === "subset" ? true : extra.length === 0) &&
    paramMismatches.length === 0;

  return {
    mode,
    matched,
    expected: [...expectedNames],
    actual: [...actualNames],
    missing,
    extra,
    paramMismatches,
  };
}
