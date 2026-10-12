import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import { createTeamController, createBullBearRiskTeam, getTeamView } from "../dist/team-controller.js";

/** 构造一个 Model（测试用，字段对齐 @aiagent/ai 的 Model）。 */
function makeModel(id = "mock-model") {
  return {
    id,
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

/** 构造一条 assistant 消息（测试用）。 */
function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

function textMessage(text, stopReason = "stop") {
  return assistantMessage([{ type: "text", text }], stopReason);
}

/**
 * 构造 mock streamFn：每次调用返回一条固定 assistant 消息的事件流（start → done）。
 * @param message 要回放的 assistant 消息。
 * @returns StreamFn 兼容函数。
 */
function createMockStreamFn(message) {
  return () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    });
    return stream;
  };
}

/** 从 controller.tools 中按名字取工具。 */
function getTool(controller, name) {
  const tool = controller.tools.find((t) => t.name === name);
  assert.ok(tool, `工具 ${name} 应已注册`);
  return tool;
}

test("TeamCreate 向 supervisor 的工具集注册，并写入 team 状态", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  assert.equal(controller.tools.length, 2);
  assert.ok(controller.tools.some((t) => t.name === "TeamCreate"));
  assert.ok(controller.tools.some((t) => t.name === "SendMessage"));

  const teamCreate = getTool(controller, "TeamCreate");
  const result = await teamCreate.execute("call-1", { name: "analyst", role: "研究员" });

  assert.equal(result.isError, undefined); // AgentToolResult 协议无 isError 字段
  assert.ok(controller.hasMember("analyst"));
  const state = controller.getTeamState();
  assert.ok(state.members.has("analyst"));
  assert.equal(state.members.get("analyst").role, "研究员");
  assert.ok(state.events.some((e) => e.type === "member_created" && e.member === "analyst"));
  // inbound 队列随成员建立。
  assert.ok(Array.isArray(state.inboundQueues.get("analyst")));
});

test("SendMessage 触发隔离 subagent 运行并回收摘要（上下文隔离 + 摘要回收 + 任务不重复）", async () => {
  // 捕获 subagent 实际收到的 LLM 上下文，验证任务未被重复注入（上下文隔离 + 零重复）。
  const captured = [];
  const streamFn = (model, context) => {
    captured.push(context);
    return createMockStreamFn(textMessage("看涨：基本面强劲"))();
  };
  const controller = createTeamController({ defaultModel: makeModel(), streamFn });
  await getTool(controller, "TeamCreate").execute("c1", { name: "analyst", role: "研究员" });

  const sendMessage = getTool(controller, "SendMessage");
  const result = await sendMessage.execute("c2", { recipient: "analyst", content: "分析 A 公司" });

  // 摘要回收为工具结果文本，主上下文不含子代理探索细节。
  assert.match(result.content[0].text, /已完成/);
  assert.match(result.content[0].text, /看涨：基本面强劲/);
  assert.equal(result.details.status, "done");
  assert.equal(result.details.summary, "看涨：基本面强劲");

  const member = controller.getTeamState().members.get("analyst");
  assert.equal(member.status, "done");
  assert.equal(member.summary, "看涨：基本面强劲");

  // 上下文隔离 + 任务不重复：子代理只被调用一次，且委派内容只出现一次
  // （回归保护：若任务同时塞进 subContext.messages 与 agentLoop 的 prompts，会重复出现）。
  assert.equal(captured.length, 1, "子代理应被调用一次");
  const subMessages = captured[0].messages;
  const taskOccurrences = subMessages.filter((m) => m.role === "user" && m.content === "分析 A 公司");
  assert.equal(taskOccurrences.length, 1, "委派任务在子代理上下文里不应重复");

  // team 状态投影：消息入队 + 成员启动 + 完成。
  const events = controller.getTeamState().events.map((e) => e.type);
  assert.ok(events.includes("message_sent"));
  assert.ok(events.includes("member_started"));
  assert.ok(events.includes("member_completed"));
  // 消息总线：inbound 队列记录了 supervisor → analyst 的派发。
  assert.equal(controller.getTeamState().inboundQueues.get("analyst").length, 1);
});

test("子代理失败以结构化错误回传，supervisor 不崩溃（失败隔离）", async () => {
  const controller = createTeamController({
    defaultModel: makeModel(),
    streamFn: createMockStreamFn(textMessage("boom", "error")),
  });
  await getTool(controller, "TeamCreate").execute("c1", { name: "risky", role: "压力测试" });

  const sendMessage = getTool(controller, "SendMessage");
  const result = await sendMessage.execute("c2", { recipient: "risky", content: "压测" });

  // 失败以可读文本 + isError:false 回传，supervisor 可继续决策。
  assert.match(result.content[0].text, /执行失败/);
  assert.equal(result.details.status, "failed");
  assert.ok(result.details.error);

  const member = controller.getTeamState().members.get("risky");
  assert.equal(member.status, "failed");
  // supervisor 主循环未崩溃：仍可查询状态 / 视图。
  assert.doesNotThrow(() => getTeamView(controller.getTeamState()));
  assert.match(controller.getTeamView(), /risky \[failed\]/);
});

test("成员不存在时 SendMessage 返回结构化错误而非抛异常", async () => {
  const controller = createTeamController({ defaultModel: makeModel(), streamFn: createMockStreamFn(textMessage("x")) });
  const result = await getTool(controller, "SendMessage").execute("c1", { recipient: "ghost", content: "hi" });
  assert.match(result.content[0].text, /执行失败/);
  assert.equal(result.details.error.code, "member_not_found");
});

test("createBullBearRiskTeam 预置 bull/bear/risk 三成员（阶段五演示）", async () => {
  const controller = createBullBearRiskTeam({
    defaultModel: makeModel("super-model"),
    readOnlyTools: ["research", "read"],
  });
  const state = controller.getTeamState();
  assert.equal(state.members.size, 3);
  for (const name of ["bull", "bear", "risk"]) {
    assert.ok(state.members.has(name), `应存在成员 ${name}`);
    assert.deepEqual(state.members.get(name).allowedTools, ["research", "read"]);
  }
  assert.match(controller.getTeamView(), /bull \[idle\]/);
});

test("getTeamView 渲染团队状态快照", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  await getTool(controller, "TeamCreate").execute("c1", { name: "m1", role: "角色一" });
  const view = controller.getTeamView();
  assert.match(view, /Team: 1 members/);
  assert.match(view, /m1 \[idle\] 角色一/);
});
