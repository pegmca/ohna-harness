/**
 * P5 · Plan-and-Execute + Reflexion：在 ReAct 内核之外挂的两阶段增强（不改 agentLoop）。
 *
 * 本文件是 barrel：把 plan-reflexion/ 下的「共享辅助 + 规划 + 反思」原样 re-export，
 * 保持公共 API 稳定、导入方零修改。编排核心 `agentLoop` 不被修改——
 * 规划在 loop 之前跑一次 LLM 拆解目标；反思复用 `shouldStopAfterTurn` /
 * `prepareNextTurn` 两个钩子做"自评估 → 重试"闭环。
 *
 * 设计要点（与 agent-loop.ts 的协作）：
 * - 全程零改 `agentLoop`；规划/反思都是 config 层挂载的"切片"，loop 内核不变。
 * - 反思用一次 LLM 调用，并在同一轮内被 `prepareNextTurn` 与 `shouldStopAfterTurn` 共享
 *   （按 message 引用缓存），避免重复调用。
 * - 反思 LLM 调用失败一律按"满意/中性"处理（结构化兜底），绝不抛错拖垮主循环。
 *
 * 各子模块：
 * - `plan-reflexion/shared.ts`：与模型交互 / 文本抽取 / JSON 容错解析的通用辅助。
 * - `plan-reflexion/planner.ts`：规划阶段（createPlanner / parsePlanFromModel）。
 * - `plan-reflexion/reflexion.ts`：反思阶段（createReflexionHook）。
 */
export * from "./plan-reflexion/shared.js";
export * from "./plan-reflexion/planner.js";
export * from "./plan-reflexion/reflexion.js";
