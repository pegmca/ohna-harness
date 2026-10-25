/**
 * W2（docs/v2.0/04 §2.2）· serve Team 接线的**事件归属域**验收。
 *
 * 覆盖：team 打开时能 spawn 子代理且子代理边界事件带 `parentId`、主线程 `llm_call` 带
 * supervisor `agentId`；team 关闭时工具表无 Team 工具、事件流无子代理事件（行为与接入前一致）；
 * team 打开但未触发 Team 工具时事件形状与单智能体一致。
 *
 * 夹具（服务构造、脚本化 streamFn、SSE 解析）见 `team-wiring-fixture.mjs`；
 * 权限 fail-closed 与并发隔离见 `team-wiring-guards.test.mjs`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPERVISOR_AGENT_ID } from "@aiagent/agent";
import {
  MODEL,
  createPlainTextStream,
  createTeamScriptStream,
  createTestServer,
  dispose,
  parseSseEvents,
  waitForTerminal
} from "./team-wiring-fixture.mjs";

test("[v2.0] team 打开：run 能 spawn 子代理，边界事件带 parentId，主线程 llm_call 带 supervisor agentId", async () => {
  const log = { calls: [] };
  const context = await createTestServer({ team: true, streamFn: createTeamScriptStream(log) });
  try {
    const { server } = context;
    const conversation = await server.createConversation("Team 接线");
    const created = await server.createRun({ conversationId: conversation.conversationId, message: "分析任务" });
    const final = await waitForTerminal(server, created.accepted.snapshotUrl);
    assert.equal(final.status, "completed");

    const events = parseSseEvents(
      (await server.app.inject({ method: "GET", url: created.accepted.eventsUrl })).body
    );

    // 1) Team 工具并入 supervisor 工具表（首次调用的 toolNames 里必须同时有两个）。
    const supervisorCall = log.calls.find((call) => call.toolNames.includes("TeamCreate"));
    assert.ok(supervisorCall, "team 打开时 supervisor 工具表必须包含 TeamCreate");
    assert.ok(supervisorCall.toolNames.includes("SendMessage"), "team 打开时 supervisor 工具表必须包含 SendMessage");

    // 2) 子代理边界事件出现在 run 事件流里，且带 agentId / parentId。
    //
    // 身份字段是**顶层**属性而不是 payload 字段：run-v2 的 AgentEvent 帧（agent_*/turn_*）
    // 整条事件体即 payload，身份随事件本体透传（§2.2 `{ ...event, agentId, parentId }`）。
    const agentStarts = events.filter((event) => event.type === "agent_start");
    assert.ok(agentStarts.length >= 2, "至少应有 supervisor 与子代理两次 agent_start");
    const subStart = agentStarts.find((event) => event.payload.agentId === "analyst");
    assert.ok(subStart, "子代理的 agent_start 必须出现在 run 事件流");
    assert.equal(subStart.payload.parentId, SUPERVISOR_AGENT_ID);
    assert.equal(subStart.payload.modelId, MODEL.id);
    assert.equal(subStart.payload.role, "分析师");
    assert.equal(agentStarts.find((event) => event.payload.agentId === SUPERVISOR_AGENT_ID)?.payload.parentId, undefined);

    const subTurns = events.filter(
      (event) => event.type.startsWith("turn_") && event.payload.agentId === "analyst"
    );
    assert.ok(subTurns.length >= 1, "子代理的 turn 边界事件同样必须转发");
    const subEnd = events.find(
      (event) => event.type === "agent_end" && event.payload.agentId === "analyst"
    );
    assert.ok(subEnd, "子代理的 agent_end 必须出现在 run 事件流");
    // 子代理生命周期在事件流里的 sequence 区间（用于判定「哪条 llm_call 属于子代理轮」）。
    const subStartRank = subStart.sequence;
    const subEndRank = subEnd.sequence;

    // 3) 全部 sequence 单调递增且唯一（子代理事件与主线程事件共用一个 counter）。
    const sequences = events.map((event) => event.sequence);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "sequence 必须单调递增");
    assert.equal(new Set(sequences).size, sequences.length, "sequence 必须唯一");

    // 4) llm_call 覆盖子代理轮，且**归因正确**（04 §2.2 第 3 条）：
    //    子代理轮次的记录必须带成员身份，主线程轮次必须带 supervisor。
    const llmCalls = events.filter((event) => event.type === "llm_call");
    assert.ok(llmCalls.length >= 3, "Team run 至少应有 supervisor 两次 + 子代理一次 llm_call");
    const subagentCalls = llmCalls.filter(
      (event) => event.sequence > subStartRank && event.sequence < subEndRank
    );
    assert.equal(subagentCalls.length, 1, "子代理轮必须恰好产出一条 llm_call");
    assert.equal(
      subagentCalls[0].payload.agentId,
      "analyst",
      "子代理的 llm_call 必须归因到成员（runMember 内的 observer 薄转发）"
    );
    // 落在子代理区间之外的记录全部属于主线程（supervisor 根身份）。
    const supervisorCalls = llmCalls.filter(
      (event) => event.sequence < subStartRank || event.sequence > subEndRank
    );
    assert.ok(supervisorCalls.length >= 3, "主线程至少 3 条 llm_call");
    assert.ok(
      supervisorCalls.every((event) => event.payload.agentId === SUPERVISOR_AGENT_ID),
      "主线程 llm_call 必须全部带 supervisor 身份"
    );
    // 两条链各自连续编号（同一 base + 同一 window + 同一 sink 路由，只是各自一条 wrapper）。
    assert.deepEqual(
      subagentCalls.map((event) => event.payload.callIndex),
      [1],
      "子代理 wrapper 的 callIndex 从 1 起"
    );
    assert.deepEqual(
      supervisorCalls.map((event) => event.payload.callIndex),
      supervisorCalls.map((_, index) => index + 1),
      "主线程 wrapper 的 callIndex 连续递增"
    );

    // 6) 事件形状：TeamCreate / SendMessage 的 tool_execution_* 与主线程一致（同一 emitTypedFrame）。
    const sendStart = events.find(
      (event) => event.type === "tool_execution_start" && event.payload.toolName === "SendMessage"
    );
    assert.ok(sendStart, "SendMessage 应有 tool_execution_start（Team 工具并入后主线程照常执行）");
    const sendEnd = events.find(
      (event) => event.type === "tool_execution_end" && event.payload.toolCallId === sendStart.payload.toolCallId
    );
    assert.ok(sendEnd, "SendMessage 应有 tool_execution_end");
    assert.ok(
      String(sendEnd.payload.result.content[0].text).includes("子代理 analyst 已完成"),
      "子代理摘要必须作为工具结果回喂 supervisor"
    );

    // 7) 团队成本段来自 serve 侧 controller（getTeamState 的第一来源），且用量非零。
    //    `budget: {}`（无上限占位）只用于触发 member.usage 回写——删掉它成本段会静默退化为
    //    0 用量成员，故此处必须校验 tokens > 0。
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.ok(costSummary, "run 收尾必须有 cost_summary");
    assert.ok(costSummary.payload.team, "团队 run 的 cost_summary 必须带 team 段");
    const member = costSummary.payload.team.members.find((entry) => entry.name === "analyst");
    assert.ok(member, "team 段必须包含 analyst");
    assert.ok(
      member.tokens > 0,
      `无上限 budget 只用于触发用量回写，member.tokens 必须 > 0（实际 ${member.tokens}）`
    );
  } finally {
    await dispose(context);
  }
});

test("[v2.0] team 关闭（缺省）：工具表无 Team 工具、事件流无子代理事件（行为与接入前一致）", async () => {
  const log = { calls: [] };
  const context = await createTestServer({ streamFn: createTeamScriptStream(log) });
  try {
    const { server } = context;
    const conversation = await server.createConversation("单智能体");
    const created = await server.createRun({ conversationId: conversation.conversationId, message: "你好" });
    const final = await waitForTerminal(server, created.accepted.snapshotUrl);
    assert.equal(final.status, "completed");

    // 工具表里没有 Team 工具 → 脚本流直接走纯文本分支。
    assert.equal(log.calls.length, 1);
    assert.ok(!log.calls[0].toolNames.includes("TeamCreate"));
    assert.ok(!log.calls[0].toolNames.includes("SendMessage"));

    const events = parseSseEvents(
      (await server.app.inject({ method: "GET", url: created.accepted.eventsUrl })).body
    );
    const agentIds = new Set(events.filter((event) => event.type === "agent_start").map((event) => event.payload.agentId));
    assert.deepEqual([...agentIds], [SUPERVISOR_AGENT_ID], "关闭 team 时只有 supervisor 一个 agent");

    // 单智能体的 llm_call 依然带 window，且 agentId = supervisor（与 team 打开时同口径）。
    const llmCall = events.find((event) => event.type === "llm_call");
    assert.ok(llmCall);
    assert.equal(llmCall.payload.agentId, SUPERVISOR_AGENT_ID);
    assert.equal(llmCall.payload.window.contextWindow, MODEL.contextWindow);
  } finally {
    await dispose(context);
  }
});

test("[v2.0] team 打开但 run 不触发 Team 工具：事件形状与单智能体一致", async () => {
  const context = await createTestServer({ team: true, streamFn: createPlainTextStream() });
  try {
    const { server } = context;
    const conversation = await server.createConversation("Team 空闲");
    const created = await server.createRun({ conversationId: conversation.conversationId, message: "你好" });
    assert.equal((await waitForTerminal(server, created.accepted.snapshotUrl)).status, "completed");

    const events = parseSseEvents(
      (await server.app.inject({ method: "GET", url: created.accepted.eventsUrl })).body
    );
    const agentIds = new Set(events.filter((event) => event.type === "agent_start").map((event) => event.payload.agentId));
    assert.deepEqual([...agentIds], [SUPERVISOR_AGENT_ID]);
    const llmCalls = events.filter((event) => event.type === "llm_call");
    assert.deepEqual(llmCalls.map((event) => event.payload.callIndex), [1]);
  } finally {
    await dispose(context);
  }
});
