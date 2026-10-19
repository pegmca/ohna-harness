/**
 * K1 权限策略内核测试。
 *
 * 覆盖验收判据：
 * - 同一 policy + 同一 PolicyState 在 CLI 适配器与 fake SSE 适配器下产生相同 decision 序列；
 * - plan 预设下 write/edit/bash 直接 deny 且零询问；
 * - 未标注 effect 的工具（MCP）默认 ask；
 * - 选择「本会话一律允许」后，同工具第二次直接 allow。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  composePolicy,
  createPermissionGate,
  createPolicyState,
  createPresetPolicy,
} from "../dist/index.js";

/** 工具表：模拟 coding registry + 一个未标注 effect 的 MCP 工具。 */
const TOOLS = [
  { name: "write", effect: "mutate" },
  { name: "edit", effect: "mutate" },
  { name: "bash", effect: "mutate" },
  { name: "read", effect: "read" },
  { name: "mcp_unknown" }
];

/**
 * 构造 beforeToolCall 的最小上下文（闸门只读 toolCall / args / context.tools）。
 *
 * @param {string} name 工具名。
 * @param {object} args 工具参数。
 * @param {number} [id] toolCall 序号（并行场景区分 id）。
 * @returns {object} BeforeToolCallContext。
 */
function contextOf(name, args, id = 1) {
  return {
    assistantMessage: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "mock",
      model: "stub",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
      stopReason: "toolUse",
      timestamp: 0
    },
    toolCall: { type: "toolCall", id: `call-${id}`, name, arguments: args },
    args,
    context: { systemPrompt: "", messages: [], tools: TOOLS }
  };
}

/**
 * 构造按预设回答序列作答的 adapter，并记录调用次数。
 *
 * @param {string[]} answers 依次返回的回答（allow / allow-session / deny）。
 * @returns {{adapter: Function, calls: object[]}} adapter 与调用记录。
 */
function scriptedAdapter(answers) {
  const calls = [];
  let index = 0;
  return {
    calls,
    adapter: async (request) => {
      calls.push(request);
      return answers[Math.min(index++, answers.length - 1)] ?? "deny";
    }
  };
}

test("双宿主一致：同一 preset + 同一 state，CLI 与 fake SSE 的 decision 序列相同", async () => {
  const cli = scriptedAdapter(["allow", "deny"]);
  const sse = scriptedAdapter(["allow", "deny"]);
  const cliState = createPolicyState();
  const sseState = createPolicyState();

  const cliGate = createPermissionGate(() => createPresetPolicy("default"), cliState, cli.adapter);
  const sseGate = createPermissionGate(() => createPresetPolicy("default"), sseState, sse.adapter);

  const cliResults = [
    await cliGate(contextOf("write", { path: "a.txt" }), undefined),
    await cliGate(contextOf("bash", { command: "npm test" }), undefined)
  ];
  const sseResults = [
    await sseGate(contextOf("write", { path: "a.txt" }), undefined),
    await sseGate(contextOf("bash", { command: "npm test" }), undefined)
  ];

  assert.equal(cliResults[0], undefined);
  assert.equal(cliResults[1]?.block, true);
  assert.deepEqual(sseResults, cliResults);
  assert.equal(cli.calls.length, 2);
  assert.equal(sse.calls.length, 2);
});

test("plan 预设：write/edit/bash 直接 deny，ask 调用次数为 0", async () => {
  const ask = scriptedAdapter(["allow"]);
  const gate = createPermissionGate(
    () => createPresetPolicy("plan"),
    createPolicyState(),
    ask.adapter
  );

  for (const [name, args] of [
    ["write", { path: "a.txt" }],
    ["edit", { path: "a.txt" }],
    ["bash", { command: "ls" }]
  ]) {
    const result = await gate(contextOf(name, args), undefined);
    assert.equal(result?.block, true, `${name} 应被拒绝`);
    assert.match(result.reason, /plan 模式/);
  }
  assert.equal(ask.calls.length, 0, "plan 模式不得触发任何询问");
});

test("未标注 effect 的工具按 mutate 保守处理（模拟 MCP）", async () => {
  const ask = scriptedAdapter(["allow"]);
  const gate = createPermissionGate(() => createPresetPolicy("default"), createPolicyState(), ask.adapter);

  const result = await gate(contextOf("mcp_unknown", { foo: "bar" }), undefined);
  assert.equal(result, undefined, "用户允许后应放行");
  assert.equal(ask.calls.length, 1, "未标注 effect 必须进入询问");
  assert.equal(ask.calls[0].effect, "mutate");
});

test("只读 effect 直接放行，且不调用策略问询", async () => {
  const ask = scriptedAdapter(["deny"]);
  const gate = createPermissionGate(() => createPresetPolicy("default"), createPolicyState(), ask.adapter);

  const result = await gate(contextOf("read", { path: "a.txt" }), undefined);
  assert.equal(result, undefined);
  assert.equal(ask.calls.length, 0);
});

test("allow-session：同工具第二次直接 allow，不再询问", async () => {
  const ask = scriptedAdapter(["allow-session", "deny"]);
  const state = createPolicyState();
  const gate = createPermissionGate(() => createPresetPolicy("default"), state, ask.adapter);

  assert.equal(await gate(contextOf("write", { path: "a.txt" }), undefined), undefined);
  assert.equal(ask.calls.length, 1);
  assert.deepEqual(state.rules(), [{ toolName: "write", target: "a.txt" }]);

  // 同一 target：会话规则命中，直接放行（第二个回答 deny 不应被消费）。
  assert.equal(await gate(contextOf("write", { path: "a.txt" }), undefined), undefined);
  assert.equal(ask.calls.length, 1);
});

test("allow-session 的路径规则不会放大到其它路径", async () => {
  const ask = scriptedAdapter(["allow-session", "deny"]);
  const state = createPolicyState();
  const gate = createPermissionGate(() => createPresetPolicy("default"), state, ask.adapter);

  assert.equal(await gate(contextOf("write", { path: "a.txt" }), undefined), undefined);
  const second = await gate(contextOf("write", { path: "b.txt" }), undefined);
  assert.equal(second?.block, true, "不同路径仍需再次询问并拒绝");
  assert.equal(ask.calls.length, 2);
});

test("composePolicy：deny 优先于 allow，allow 优先于 ask", () => {
  const allow = { decide: () => ({ outcome: "allow" }) };
  const deny = { decide: () => ({ outcome: "deny", reason: "blocked" }) };
  const ask = { decide: () => ({ outcome: "ask", summary: "ask" }) };
  const state = createPolicyState();
  const request = { toolName: "write", args: {}, effect: "mutate" };

  assert.deepEqual(composePolicy(allow, deny).decide(request, state), { outcome: "deny", reason: "blocked" });
  assert.deepEqual(composePolicy(ask, allow).decide(request, state), { outcome: "allow" });
  assert.deepEqual(composePolicy(ask, ask).decide(request, state), { outcome: "ask", summary: "ask" });
});

test("acceptEdits：write/edit 放行，bash 仍需询问", async () => {
  const ask = scriptedAdapter(["allow"]);
  const gate = createPermissionGate(
    () => createPresetPolicy("acceptEdits"),
    createPolicyState(),
    ask.adapter
  );

  assert.equal(await gate(contextOf("write", { path: "a.txt" }), undefined), undefined);
  assert.equal(await gate(contextOf("edit", { path: "a.txt" }), undefined), undefined);
  assert.equal(ask.calls.length, 0);
  assert.equal(await gate(contextOf("bash", { command: "ls" }), undefined), undefined);
  assert.equal(ask.calls.length, 1);
});

test("signal 已取消时闸门直接拒绝，不进入策略 / 问询", async () => {
  const ask = scriptedAdapter(["allow"]);
  const gate = createPermissionGate(() => createPresetPolicy("bypass"), createPolicyState(), ask.adapter);
  const controller = new AbortController();
  controller.abort();

  const result = await gate(contextOf("write", { path: "a.txt" }), controller.signal);
  assert.equal(result?.block, true);
  assert.match(result.reason, /已取消/);
  assert.equal(ask.calls.length, 0);
});
