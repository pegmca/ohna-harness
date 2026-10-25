/**
 * Team L1 纯函数投影层（docs/v2.0/03-team-eval.md §6.1，T-L1 硬门禁）。
 *
 * 存在理由：此前「摘要回收」「失败隔离」「权限继承通道」三条编排机契约只能靠
 * 「注入固定模型输出（createMockStreamFn）」间接测到，属于 v2.0 §4.2 红线禁止的
 * 「mock 模型输出」。把这部分逻辑下沉为本模块的纯函数后：
 * - 逻辑正确性由 L1 纯函数断言覆盖（零 IO、零模型、100% 确定性）；
 * - L2b 只保留「真 provider 驱动下这些逻辑确实被串起来」的集成验证；
 * - controller 只做编排与运行期副作用（状态回写、护栏触发标记），不再内联判定逻辑。
 *
 * 三条纪律（本模块全部函数必须遵守）：
 * 1. **零副作用**：不读时钟、不写状态、不调用模型 / 工具 / IO。
 * 2. **引用保真**：凡「原样透传」语义（model / convertToLlm / beforeToolCall / endError），
 *    一律返回**同一引用**而非深拷贝，调用方可用 `===` 断言继承通道。
 * 3. **键存在性即契约**：`key in config` 的布尔结果本身就是编排机契约的一部分
 *    （「无权限装配 / 无预算」场景必须零多余钩子），因此用条件展开而非赋 undefined。
 */
import { SUPERVISOR_AGENT_ID } from "../types.js";
import type { AgentLoopConfig, AgentLoopError, AgentIdentity, AgentMessage } from "../types.js";
import type { MemberBudgetHook } from "./budget.js";
import type { TeamMember } from "./types.js";

/**
 * 从子代理最终消息集提取「摘要 + 产物引用」（上下文隔离的第一性）。
 * 摘要取最后一条 assistant 文本；产物收集所有 toolResult 的工具名 + 短摘要。
 * 纯函数，零 IO，可脱离 agentLoop 直接测。
 *
 * 实现要点（对齐 docs/v2.0/03 §6.1.1 断言清单）：
 * - 摘要**逆向扫描**：取最后一条「文本内容非空」的 assistant，而不是第一条——
 *   子代理常有多轮 toolUse（空文本）后才是最终结论，正向取首条会拿到过程消息。
 * - 产物**正向保序**：artifacts 与 messages 中的 toolResult 出现顺序一致，
 *   便于 supervisor 按「先做什么后做什么」引用产物。
 *
 * @param messages 子代理 agentLoop 最终回写的消息集（含 prompt 与工具结果）。
 * @returns 摘要文本与产物引用列表；无 assistant 文本时 summary 为「(子代理无文本输出)」。
 */
export function extractSummary(messages: AgentMessage[]): { summary: string; artifacts: string[] } {
  let summary = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) {
        summary = text;
        break;
      }
    }
  }
  const artifacts = messages
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      // 截断到 120 字符：产物引用只做「可辨识的短摘要」，完整结果留在子代理上下文里不外泄。
      const text = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(" ")
        .slice(0, 120);
      return `${m.toolName}:${text || "(空)"}`;
    });
  return { summary: summary || "(子代理无文本输出)", artifacts };
}

/**
 * 把「子代理是否异常终止」的判定抽成纯函数（失败隔离的确定性证据源）。
 * 判定：agent_end.error（兜底收尾）或最终 assistant 的 stopReason 为 error/aborted。
 *
 * 语义边界：
 * - `endError` 有值 → 视为失败，且 **原样透传** `{code, message}`（不重包装成
 *   subagent_failed），让 supervisor 看到的错误码来自真实故障源（如 agent_loop_aborted）。
 * - `endError` 无值但 `lastAssistant` 也缺失 → 仍判失败，message 固定为 "unknown"
 *   （对齐 controller 兜底：既无兜底错误、又无任何 assistant 产出 = 不可判定即失败）。
 * - `stopReason` 为其他值（stop/length/toolUse）→ 正常结束，`error` 键不出现。
 * - **`lastAssistant` 存在但不是 assistant 消息**（类型误用）→ 返回 `aborted: false`，
 *   **不是** fail-closed。契约依据：`user` / `toolResult` 均不携带 `stopReason`，
 *   即「没有任何终止信号」；抽取前 controller 对该情形同样判 false（`undefined` 不命中
 *   error/aborted 分支）。本函数只负责忠实投影停止信号，**不承担**「调用方传错类型」的
 *   防御职责——调用方契约是传入 `messages` 中最后一条 assistant。
 *   需要 fail-closed 语义的上层应自行校验入参类型，不可依赖本函数。
 *
 * @param input.endError agent_end 携带的兜底错误（AgentLoopError）；正常结束为 undefined。
 * @param input.lastAssistant messages 中最后一条 assistant 消息（可能为 undefined）。
 * @returns aborted=true 时携带结构化 error（endError 优先，否则由 stopReason 派生）。
 */
export function classifyAborted(input: {
  endError: AgentLoopError | undefined;
  lastAssistant: AgentMessage | undefined;
}): { aborted: boolean; error?: { code: string; message: string } } {
  const { endError, lastAssistant } = input;
  // endError 优先且原样透传：它是 agent-loop 兜底收尾的真实故障，比派生码更有诊断价值。
  if (endError) return { aborted: true, error: { code: endError.code, message: endError.message } };
  // 无 assistant 消息：既无兜底错误也无产出，按失败处理（不可判定即失败，fail-closed）。
  if (lastAssistant === undefined) {
    return { aborted: true, error: { code: "subagent_failed", message: "unknown" } };
  }
  // 【已文档化契约】非 assistant 的 lastAssistant → aborted:false（见本函数 JSDoc 与
  // docs/v2.0/03-team-eval.md §6.1.2）。理由：AgentMessage 联合含 user / toolResult，
  // 二者都不携带 stopReason，即「没有任何终止信号」，抽取前在原实现中同样判 false。
  // 本分支仅为与 controller 抽取前**严格行为等价**而存在，不是「类型误用兜底」：
  // 若未来要改为 fail-closed，必须同时改 docs §6.1.2 与 team-pure.test.mjs 的断言。
  if (lastAssistant.role !== "assistant") return { aborted: false };
  if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
    return {
      aborted: true,
      error: { code: "subagent_failed", message: `stopReason: ${lastAssistant.stopReason}` },
    };
  }
  return { aborted: false };
}

/**
 * 装配子代理的 AgentLoopConfig（编排机契约 + 权限继承通道）。
 * 纯函数：只根据输入决定 config 里有哪些键、值是什么引用，不做任何运行期副作用。
 *
 * 关键边界：本函数只负责「静态装配」——
 * - beforeToolCall 有值 → 原样透传（同一引用），保证子代理与 supervisor 共用同一闸门；
 * - budgetHook 有值 → 注入 shouldStopAfterTurn 直通 hook.shouldStopAfterTurn；
 * - 两者皆无 → config 不含对应键（保持「无权限装配/无预算」场景零多余钩子）。
 *
 * `budgetHook` 有值时注入的是 **hook 的原始方法**（不是箭头包装），避免任何隐式 this 丢失；
 * 「hook 触发时标记 budgetExceeded」这个运行期副作用**不属于本函数**：由 runMember 在拿到
 * 返回的 config 后自行薄包装 shouldStopAfterTurn 捕获 stoppedByBudget。
 *
 * 不含 deadlineMs：agent-loop 从不消费该字段，真正生效的是护栏闭包内的墙钟自查（A-2 修复）。
 * 误注入会制造「以为设了 deadline」的错误安全感，故此处显式不写。
 *
 * v2.0 增补 `identity`（docs/v2.0/04 §1.3）：子代理身份 = member 的 name/role/model.id，
 * `parentId` 恒为 supervisor 根 id。身份在这里装配而非在 controller 里拼，是为了让
 * 「派生身份」这条契约同样可由 L1 纯函数断言（不依赖任何运行期状态）。
 *
 * @param input.member 目标成员（提供 model 与工具子集，供权限闸门解析 effect）。
 * @param input.budgetHook 成本护栏句柄（未配置预算时为 undefined）。
 * @param input.beforeToolCall supervisor 的权限闸门（K3 策略继承来源，可为 undefined）。
 * @param input.convertToLlm 子代理消息→LLM 消息转换器。
 * @returns 装配好的 AgentLoopConfig（model 取 member.model，同一引用；identity 为新对象）。
 */
export function assembleSubagentConfig(input: {
  member: TeamMember;
  budgetHook: MemberBudgetHook | undefined;
  beforeToolCall: AgentLoopConfig["beforeToolCall"] | undefined;
  convertToLlm: AgentLoopConfig["convertToLlm"];
}): AgentLoopConfig {
  const { member, budgetHook, beforeToolCall, convertToLlm } = input;
  return {
    model: member.model,
    convertToLlm,
    identity: deriveSubagentIdentity(member),
    // K3 策略继承：子代理的 context.tools 是它自己的工具子集，闸门从该上下文解析 effect，
    // 因此 write/edit/bash 在子代理内部同样走 ask/deny，并写入共享 PolicyState。
    ...(beforeToolCall ? { beforeToolCall } : {}),
    // 成本护栏：直通 hook 方法（保留原始函数引用语义），触发时返回 true 干净停止。
    ...(budgetHook ? { shouldStopAfterTurn: budgetHook.shouldStopAfterTurn } : {}),
  };
}

/**
 * 派生子代理身份（纯函数）：`agentId = member.name`（消息总线寻址键，稳定），
 * `parentId` 恒为 supervisor 根 id。
 *
 * @param member 目标成员。
 * @returns 子代理身份（新对象，未做任何深拷贝以外的加工）。
 */
export function deriveSubagentIdentity(member: TeamMember): AgentIdentity {
  return {
    agentId: member.name,
    parentId: SUPERVISOR_AGENT_ID,
    label: member.name,
    role: member.role,
    modelId: member.model.id,
  };
}
