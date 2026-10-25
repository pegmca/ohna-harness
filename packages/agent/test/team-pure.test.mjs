/**
 * T-L1 纯函数投影硬门禁（docs/v2.0/03-team-eval.md §6.1）。
 *
 * 本文件覆盖三条编排机契约的**逻辑正确性**，全部零 IO、零模型、零 provider：
 * - §6.1.1 extractSummary：摘要回收（上下文隔离的第一性）
 * - §6.1.2 classifyAborted：失败隔离判定
 * - §6.1.3 assembleSubagentConfig：子代理 config 静态装配 + 权限继承通道
 *
 * 与 L2b 的分工：这里断言「逻辑对不对」（100% 确定性、PR 硬门禁），
 * L2b 只断言「真 provider 下这些逻辑确实被串起来」（控制流）。
 * 本文件**不得**出现任何 mock 模型输出 / mock streamFn（v2.0 §4.2 红线）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleSubagentConfig,
  classifyAborted,
  extractSummary,
} from "../dist/team-controller.js";

/** 构造一个 Model（字段对齐 @aiagent/ai 的 Model）；只做形状填充，不连接任何 provider。 */
function makeModel(id = "pure-test-model") {
  return {
    id,
    name: "Pure",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

/** 构造一条 assistant 消息（形状对齐 AssistantMessage）。 */
function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "pure-test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/** 构造一条纯文本 assistant 消息。 */
function textMessage(text, stopReason = "stop") {
  return assistantMessage([{ type: "text", text }], stopReason);
}

/** 构造一条 user 消息（子代理 prompt）。 */
function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** 构造一条 toolResult 消息。 */
function toolResultMessage(toolName, content) {
  return {
    role: "toolResult",
    toolCallId: `call-${toolName}`,
    toolName,
    content,
    isError: false,
    timestamp: Date.now(),
  };
}

/** 构造一个 TeamMember（只填充纯函数关心的字段）。 */
function makeMember(overrides = {}) {
  return {
    name: "alice",
    role: "评审",
    model: makeModel(),
    status: "idle",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §6.1.1 extractSummary
// ---------------------------------------------------------------------------

test("extractSummary：无任何 assistant 消息 → 占位摘要 + 空产物", () => {
  const result = extractSummary([userMessage("做点事")]);
  assert.equal(result.summary, "(子代理无文本输出)");
  assert.deepEqual(result.artifacts, []);
});

test("extractSummary：空消息集 → 同样返回占位摘要与空产物", () => {
  assert.deepEqual(extractSummary([]), { summary: "(子代理无文本输出)", artifacts: [] });
});

test("extractSummary：assistant 文本为空串（仅 thinking）→ 视为无文本输出", () => {
  const messages = [
    userMessage("任务"),
    assistantMessage([{ type: "thinking", thinking: "内部推理" }]),
  ];
  assert.equal(extractSummary(messages).summary, "(子代理无文本输出)");
});

test("extractSummary：末条 assistant 文本非空 → summary 等于该条文本内容块拼接", () => {
  const messages = [
    userMessage("任务"),
    textMessage("第一段"),
    textMessage("第二段"),
  ];
  assert.equal(extractSummary(messages).summary, "第二段");
});

test("extractSummary：同一条 assistant 多个 text 内容块 → 以换行拼接", () => {
  const messages = [
    userMessage("任务"),
    assistantMessage([
      { type: "text", text: "行一" },
      { type: "thinking", thinking: "忽略" },
      { type: "text", text: "行二" },
    ]),
  ];
  assert.equal(extractSummary(messages).summary, "行一\n行二");
});

test("extractSummary：多条 assistant → 取最后一条非空（逆向扫描），不是第一条", () => {
  const messages = [
    userMessage("任务"),
    textMessage("最早的结论"),
    textMessage("中间的结论"),
  ];
  assert.equal(extractSummary(messages).summary, "中间的结论");
});

test("extractSummary：末条 assistant 无文本（toolUse）→ 回退到更早的非空 assistant", () => {
  const messages = [
    userMessage("任务"),
    textMessage("阶段性结论"),
    assistantMessage([], "toolUse"),
  ];
  assert.equal(extractSummary(messages).summary, "阶段性结论");
});

test("extractSummary：toolResult 投影为 `${toolName}:${文本}`，且顺序与消息顺序一致", () => {
  const messages = [
    userMessage("任务"),
    assistantMessage([], "toolUse"),
    toolResultMessage("read", [{ type: "text", text: "文件内容A" }]),
    assistantMessage([], "toolUse"),
    toolResultMessage("grep", [{ type: "text", text: "命中3处" }]),
    textMessage("完成"),
  ];
  const { summary, artifacts } = extractSummary(messages);
  assert.equal(summary, "完成");
  assert.deepEqual(artifacts, ["read:文件内容A", "grep:命中3处"]);
});

test("extractSummary：toolResult 多个文本块以空格拼接（与文本摘要用换行拼接不同）", () => {
  const messages = [
    toolResultMessage("ls", [
      { type: "text", text: "a.ts" },
      { type: "text", text: "b.ts" },
    ]),
  ];
  assert.deepEqual(extractSummary(messages).artifacts, ["ls:a.ts b.ts"]);
});

test("extractSummary：toolResult 无文本内容 → 产物文本部分为 (空)", () => {
  const messages = [toolResultMessage("write", [])];
  assert.deepEqual(extractSummary(messages).artifacts, ["write:(空)"]);
});

test("extractSummary：toolResult 文本截断到 120 字符", () => {
  const long = "x".repeat(200);
  const messages = [toolResultMessage("bash", [{ type: "text", text: long }])];
  const [artifact] = extractSummary(messages).artifacts;
  assert.equal(artifact, `bash:${"x".repeat(120)}`);
  assert.equal(artifact.length, "bash:".length + 120);
});

// ---------------------------------------------------------------------------
// §6.1.2 classifyAborted
// ---------------------------------------------------------------------------

test("classifyAborted：endError 有值 → aborted，且 error 逐字段等于 endError（不重包装）", () => {
  const endError = { code: "agent_loop_aborted", message: "外部取消" };
  const verdict = classifyAborted({
    endError,
    lastAssistant: textMessage("这段文本不应影响判定"),
  });
  assert.equal(verdict.aborted, true);
  assert.deepEqual(verdict.error, endError);
  // 码透传：不得被改写成 subagent_failed。
  assert.equal(verdict.error.code, "agent_loop_aborted");
});

test("classifyAborted：endError 优先于 stopReason（stopReason=stop 也判失败）", () => {
  const verdict = classifyAborted({
    endError: { code: "hook_threw", message: "钩子抛错" },
    lastAssistant: textMessage("看起来正常", "stop"),
  });
  assert.equal(verdict.aborted, true);
  assert.deepEqual(verdict.error, { code: "hook_threw", message: "钩子抛错" });
});

test("classifyAborted：endError=undefined 且 stopReason=error → subagent_failed", () => {
  const verdict = classifyAborted({ endError: undefined, lastAssistant: textMessage("", "error") });
  assert.equal(verdict.aborted, true);
  assert.equal(verdict.error.code, "subagent_failed");
  assert.match(verdict.error.message, /stopReason: error/);
});

test("classifyAborted：endError=undefined 且 stopReason=aborted → subagent_failed", () => {
  const verdict = classifyAborted({ endError: undefined, lastAssistant: textMessage("", "aborted") });
  assert.equal(verdict.aborted, true);
  assert.equal(verdict.error.code, "subagent_failed");
  assert.match(verdict.error.message, /stopReason: aborted/);
});

test("classifyAborted：endError=undefined 且 lastAssistant=undefined → subagent_failed / unknown", () => {
  const verdict = classifyAborted({ endError: undefined, lastAssistant: undefined });
  assert.equal(verdict.aborted, true);
  assert.equal(verdict.error.code, "subagent_failed");
  assert.equal(verdict.error.message, "unknown");
});

test("classifyAborted：stopReason=stop → aborted=false 且 error 键不出现", () => {
  const verdict = classifyAborted({ endError: undefined, lastAssistant: textMessage("正常收尾", "stop") });
  assert.equal(verdict.aborted, false);
  assert.equal(verdict.error, undefined);
  assert.equal("error" in verdict, false);
});

test("classifyAborted：stopReason=length / toolUse 等非错误终止 → aborted=false", () => {
  for (const stopReason of ["length", "toolUse"]) {
    const verdict = classifyAborted({ endError: undefined, lastAssistant: textMessage("", stopReason) });
    assert.equal(verdict.aborted, false, `stopReason=${stopReason} 不应判失败`);
    assert.equal("error" in verdict, false);
  }
});

test("classifyAborted：lastAssistant 非 assistant（类型误用）→ 契约规定 aborted=false，不是 fail-closed", () => {
  // 契约锁定（docs/v2.0/03-team-eval.md §6.1.2）：user / toolResult 不携带 stopReason，
  // 即「没有任何终止信号」，抽取前 controller 同样判 falsy。本断言防的是「未来被静默改成
  // fail-closed」——若确要变更契约，必须同步改文档与本断言，而非让其悄悄通过。
  const misuseCases = [
    userMessage("这是 user 消息，不该被当成 lastAssistant"),
    toolResultMessage("read", [{ type: "text", text: "工具结果" }]),
  ];
  for (const misused of misuseCases) {
    const verdict = classifyAborted({ endError: undefined, lastAssistant: misused });
    assert.equal(verdict.aborted, false, `${misused.role} 作为 lastAssistant 时应按契约判 aborted=false`);
    assert.equal("error" in verdict, false);
  }
});

test("classifyAborted：类型误用但 endError 有值 → 仍以 endError 判失败（优先于角色判定）", () => {
  // 兜底错误的存在性优先于 lastAssistant 的角色，保证真实故障不被类型误用掩盖。
  const verdict = classifyAborted({
    endError: { code: "agent_loop_aborted", message: "取消" },
    lastAssistant: userMessage("不是 assistant"),
  });
  assert.equal(verdict.aborted, true);
  assert.deepEqual(verdict.error, { code: "agent_loop_aborted", message: "取消" });
});

// ---------------------------------------------------------------------------
// §6.1.3 assembleSubagentConfig
// ---------------------------------------------------------------------------

/** 构造一个 budgetHook 假体（纯函数只做静态装配，不会调用钩子）。 */
function makeBudgetHook() {
  const shouldStopAfterTurn = async () => false;
  return { shouldStopAfterTurn, usage: { tokens: 0, cost: 0 } };
}

test("assembleSubagentConfig：model 严格等于 member.model（同一引用）", () => {
  const member = makeMember();
  const config = assembleSubagentConfig({
    member,
    budgetHook: undefined,
    beforeToolCall: undefined,
    convertToLlm: () => [],
  });
  assert.equal(config.model, member.model);
  assert.equal(config.model.id, member.model.id);
});

test("assembleSubagentConfig：convertToLlm 严格等于入参（同一引用）", () => {
  const convertToLlm = (messages) => messages;
  const config = assembleSubagentConfig({
    member: makeMember(),
    budgetHook: undefined,
    beforeToolCall: undefined,
    convertToLlm,
  });
  assert.equal(config.convertToLlm, convertToLlm);
});

test("assembleSubagentConfig：beforeToolCall 有值 → 同一引用透传（K3 继承通道）", () => {
  const beforeToolCall = async () => undefined;
  const config = assembleSubagentConfig({
    member: makeMember(),
    budgetHook: undefined,
    beforeToolCall,
    convertToLlm: () => [],
  });
  assert.equal(config.beforeToolCall, beforeToolCall);
});

test("assembleSubagentConfig：beforeToolCall 为 undefined → config 不含该键（零多余钩子）", () => {
  const config = assembleSubagentConfig({
    member: makeMember(),
    budgetHook: undefined,
    beforeToolCall: undefined,
    convertToLlm: () => [],
  });
  assert.equal("beforeToolCall" in config, false);
});

test("assembleSubagentConfig：budgetHook 有值 → shouldStopAfterTurn 存在且为函数", () => {
  const budgetHook = makeBudgetHook();
  const config = assembleSubagentConfig({
    member: makeMember(),
    budgetHook,
    beforeToolCall: undefined,
    convertToLlm: () => [],
  });
  assert.equal(typeof config.shouldStopAfterTurn, "function");
  // 直通 hook 的原始方法（同引用），不做二次包装——包装是 runMember 的职责。
  assert.equal(config.shouldStopAfterTurn, budgetHook.shouldStopAfterTurn);
});

test("assembleSubagentConfig：budgetHook 为 undefined → config 不含 shouldStopAfterTurn 键", () => {
  const config = assembleSubagentConfig({
    member: makeMember(),
    budgetHook: undefined,
    beforeToolCall: async () => undefined,
    convertToLlm: () => [],
  });
  assert.equal("shouldStopAfterTurn" in config, false);
  // 权限通道仍在：两个钩子互不牵连（有权限、无预算）。
  assert.equal(typeof config.beforeToolCall, "function");
});

test("assembleSubagentConfig：绝不含 deadlineMs（A-2：agent-loop 不消费该字段）", () => {
  const config = assembleSubagentConfig({
    member: makeMember(),
    budgetHook: makeBudgetHook(),
    beforeToolCall: async () => undefined,
    convertToLlm: () => [],
  });
  assert.equal("deadlineMs" in config, false);
});

test("assembleSubagentConfig：两个钩子皆无 → config 只有 model + convertToLlm + identity 三个键", () => {
  const config = assembleSubagentConfig({
    member: makeMember(),
    budgetHook: undefined,
    beforeToolCall: undefined,
    convertToLlm: () => [],
  });
  // identity 自 v2.0（docs/v2.0/04 §1.3）起是**无条件**装配的：AgentEvent 的身份字段必填，
  // 子代理不能让 agentLoop 兜底成 supervisor 根身份，否则 Trace 森林无法区分派发者与被派发者。
  assert.deepEqual(Object.keys(config).sort(), ["convertToLlm", "identity", "model"]);
});

test("assembleSubagentConfig：identity 派生为子代理身份（agentId=name / parentId=supervisor）", () => {
  const member = makeMember({ name: "bull-reviewer", role: "多头评审" });
  const config = assembleSubagentConfig({
    member,
    budgetHook: undefined,
    beforeToolCall: undefined,
    convertToLlm: () => [],
  });
  assert.deepEqual(config.identity, {
    agentId: "bull-reviewer",
    parentId: "supervisor",
    label: "bull-reviewer",
    role: "多头评审",
    modelId: member.model.id,
  });
});

test("assembleSubagentConfig：纯函数——不修改入参、重复调用结果稳定", () => {
  const member = makeMember();
  const budgetHook = makeBudgetHook();
  const beforeToolCall = async () => undefined;
  const convertToLlm = () => [];
  const snapshot = JSON.stringify({ member, usage: budgetHook.usage });

  const first = assembleSubagentConfig({ member, budgetHook, beforeToolCall, convertToLlm });
  const second = assembleSubagentConfig({ member, budgetHook, beforeToolCall, convertToLlm });

  assert.deepEqual(first, second);
  assert.equal(first.model, second.model);
  assert.equal(first.beforeToolCall, second.beforeToolCall);
  assert.equal(JSON.stringify({ member, usage: budgetHook.usage }), snapshot);
  // 返回的是新对象字面量，调用方后续改写不会污染入参。
  assert.notEqual(first, second);
});
