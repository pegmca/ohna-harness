import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import {
  createCommandJudger,
  createGoalController,
  createLlmJudger,
} from "../dist/goal-controller.js";

/** 构造一条 assistant 消息（复用 agent-loop 测试的形状）。 */
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

/** 构造一个最小的 AgentContext（判定器只读，不写入）。 */
function agentContext() {
  return { systemPrompt: "sys", messages: [] };
}

/** 构造一条进度快照，供 GoalJudgeContext.progress 使用。 */
function progress(overrides = {}) {
  return {
    goalText: "g",
    achieved: false,
    completedSteps: [],
    remainingSteps: [],
    turns: 1,
    startedAt: Date.now(),
    ...overrides,
  };
}

/** 组装 GoalJudgeContext（判定器所需的最小上下文）。 */
function judgeContext(overrides = {}) {
  return {
    goalText: "g",
    message: assistantMessage([{ type: "text", text: "x" }]),
    toolResults: [],
    context: agentContext(),
    newMessages: [],
    turns: 1,
    progress: progress(),
    ...overrides,
  };
}

const MODEL = {
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

/** 构造一个把给定文本作为 done 消息返回的 mock streamFn（供 LlmJudger 注入）。 */
function createMockJudgeStreamFn(text) {
  return async () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      const msg = assistantMessage([{ type: "text", text }], "stop");
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: "stop", message: msg });
    });
    return stream;
  };
}

test("CommandJudger: exit 0 => achieved", async () => {
  const judger = createCommandJudger({
    command: "true",
    runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });
  const res = await judger.judge(judgeContext());
  assert.equal(res.achieved, true);
  assert.match(res.reason, /退出码 0/);
});

test("CommandJudger: non-zero exit => not achieved, stderr captured as reason", async () => {
  const judger = createCommandJudger({
    command: "false",
    runCommand: async () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
  });
  const res = await judger.judge(judgeContext());
  assert.equal(res.achieved, false);
  assert.match(res.reason, /退出码 2/);
  assert.match(res.reason, /boom/);
});

test("LlmJudger: parses achieved JSON from model output", async () => {
  const streamFn = createMockJudgeStreamFn(
    JSON.stringify({ achieved: true, reason: "all green", completedSteps: ["a", "b"], remainingSteps: [] }),
  );
  const judger = createLlmJudger({ goalText: "ship it", model: MODEL, streamFn });
  const res = await judger.judge(judgeContext({ goalText: "ship it" }));
  assert.equal(res.achieved, true);
  assert.equal(res.reason, "all green");
  assert.deepEqual(res.completedSteps, ["a", "b"]);
  assert.deepEqual(res.remainingSteps, []);
});

test("LlmJudger: tolerates markdown-fenced JSON and not-achieved", async () => {
  const streamFn = createMockJudgeStreamFn(
    "```json\n" + JSON.stringify({ achieved: false, reason: "tests failing" }) + "\n```",
  );
  const judger = createLlmJudger({ goalText: "g", model: MODEL, streamFn });
  const res = await judger.judge(judgeContext());
  assert.equal(res.achieved, false);
  assert.equal(res.reason, "tests failing");
});

test("GoalController: shouldStopAfterTurn true when judger achieved", async () => {
  const judger = createCommandJudger({
    command: "x",
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const ctrl = createGoalController({ goalText: "g", judger });
  const stop = await ctrl.hooks.shouldStopAfterTurn(judgeContext());
  assert.equal(stop, true);
  assert.equal(ctrl.getProgress().achieved, true);
});

test("GoalController: not achieved => continue, follow-up meta message returned", async () => {
  const judger = createCommandJudger({
    command: "x",
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "fail" }),
  });
  const ctrl = createGoalController({ goalText: "build the thing", judger });
  const stop = await ctrl.hooks.shouldStopAfterTurn(judgeContext());
  assert.equal(stop, false);
  const msgs = await ctrl.hooks.getFollowUpMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
  assert.match(msgs[0].content, /目标未达成/);
  assert.match(msgs[0].content, /build the thing/);
});

test("GoalController: achieved => no follow-up message", async () => {
  const judger = createCommandJudger({
    command: "x",
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const ctrl = createGoalController({ goalText: "g", judger });
  await ctrl.hooks.shouldStopAfterTurn(judgeContext());
  const msgs = await ctrl.hooks.getFollowUpMessages();
  assert.equal(msgs.length, 0);
});

test("GoalController: maxTurns budget forces stop and marks not achieved", async () => {
  const judger = createCommandJudger({
    command: "x",
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "fail" }),
  });
  const ctrl = createGoalController({ goalText: "g", judger, maxTurns: 3 });
  const ctx = judgeContext();
  assert.equal(await ctrl.hooks.shouldStopAfterTurn(ctx), false);
  assert.equal(await ctrl.hooks.shouldStopAfterTurn(ctx), false);
  assert.equal(await ctrl.hooks.shouldStopAfterTurn(ctx), true);
  assert.equal(ctrl.getProgress().turns, 3);
  assert.equal(ctrl.getProgress().achieved, false);
});

test("GoalController: completedSteps accumulate and surface in follow-up", async () => {
  let call = 0;
  const judger = {
    async judge() {
      call += 1;
      // 第一轮未完成且给出剩余项；第二轮判定为已完成一步。
      if (call === 1) {
        return { achieved: false, reason: "r1", completedSteps: [], remainingSteps: ["step2"] };
      }
      return { achieved: false, reason: "r2", completedSteps: ["step1"], remainingSteps: ["step2"] };
    },
  };
  const ctrl = createGoalController({ goalText: "g", judger });
  await ctrl.hooks.shouldStopAfterTurn(judgeContext());
  const first = await ctrl.hooks.getFollowUpMessages();
  assert.match(first[0].content, /剩余：step2/);
  await ctrl.hooks.shouldStopAfterTurn(judgeContext());
  const second = await ctrl.hooks.getFollowUpMessages();
  assert.match(second[0].content, /已完成：step1/);
  // 已完成子任务跨轮累积（并集去重）。
  assert.deepEqual(ctrl.getProgress().completedSteps, ["step1"]);
});
