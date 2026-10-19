/**
 * K3 权限闸门转发器单测：闸门未就绪必须 fail-closed，就绪后原样透传。
 *
 * 该转发层是 team controller（先建）与 REPL 闸门（后建）之间的桥；fail-open 会在
 * 未来入口漏回调时静默绕过审批，因此这里把安全性锁死在单测里。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTeamGateForwarder, createTeamToolset } from "../dist/runtime/team-wiring.js";

/** 构造一个最小可用的 beforeToolCall 上下文（转发器只透传，不读取内容）。 */
function fakeContext(toolName = "write") {
  return {
    assistantMessage: {},
    toolCall: { type: "toolCall", id: "t1", name: toolName, arguments: {} },
    args: {},
    context: { systemPrompt: "", messages: [], tools: [] },
  };
}

test("gateRef 未就绪：子代理的 mutating 工具被 block（fail-closed）", async () => {
  const forward = createTeamGateForwarder(() => undefined);
  const result = await forward(fakeContext("write"));
  assert.equal(result?.block, true, "闸门未就绪时必须拒绝，而不是静默放行");
  assert.match(result?.reason ?? "", /权限闸门未就绪/);
});

test("gateRef 就绪：原样透传上下文、signal 与返回值", async () => {
  const seen = [];
  const gate = async (context, signal) => {
    seen.push({ toolName: context.toolCall.name, signal });
    return { block: true, reason: "plan 模式拒绝" };
  };
  const forward = createTeamGateForwarder(() => gate);
  const controller = new AbortController();
  const result = await forward(fakeContext("bash"), controller.signal);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolName, "bash");
  assert.equal(seen[0].signal, controller.signal, "signal 必须透传，确保中断语义一致");
  assert.equal(result?.reason, "plan 模式拒绝");
});

/** 构造一个最小模型对象（仅 team controller 读取 id / 费率等字段）。 */
function fakeModel() {
  return {
    id: "mock-model",
    name: "Mock",
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

test("--no-team：工具表不注册 TeamCreate / SendMessage（F-4）", () => {
  const toolset = createTeamToolset({
    enabled: false,
    codingTools: [],
    defaultModel: fakeModel(),
    getGate: () => undefined,
  });
  assert.deepEqual(toolset.tools, [], "关闭时不得注册任何 team 工具");
  assert.equal(toolset.teamToolNames.size, 0);
});

test("默认开启：工具表含 TeamCreate / SendMessage 且标注为 Team 来源", () => {
  const toolset = createTeamToolset({
    enabled: true,
    codingTools: [],
    defaultModel: fakeModel(),
    getGate: () => undefined,
  });
  assert.deepEqual(
    toolset.tools.map((tool) => tool.name),
    ["TeamCreate", "SendMessage"],
  );
  assert.deepEqual([...toolset.teamToolNames], ["TeamCreate", "SendMessage"]);
});
