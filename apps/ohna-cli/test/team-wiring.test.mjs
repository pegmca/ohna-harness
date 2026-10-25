/**
 * K3 权限闸门转发器单测：闸门未就绪必须 fail-closed，就绪后原样透传。
 *
 * 该转发层是 team controller（先建）与 REPL 闸门（后建）之间的桥；fail-open 会在
 * 未来入口漏回调时静默绕过审批，因此这里把安全性锁死在单测里。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { projectTeamCostSummary } from "@aiagent/agent";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { hostOhnaWeb, releaseHost } from "../dist/cli/web-host.js";
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

// G-T1（docs/v2.0/03-team-eval.md §9.1）：controller 引用不再被丢弃，getTeamState 是
// 组合根通往 serve 的唯一成本投影入口。两侧语义必须钉死：
//   enabled=true  → 暴露 getTeamState，且返回的是 controller 的实时内存快照；
//   enabled=false → 返回对象**不含该键**（不是 undefined 值），保持旧形状向后兼容。
test("enabled=false：返回对象不含 getTeamState 键（旧形状向后兼容）", () => {
  const toolset = createTeamToolset({
    enabled: false,
    codingTools: [],
    defaultModel: fakeModel(),
    getGate: () => undefined,
  });
  assert.equal("getTeamState" in toolset, false, "--no-team 时不得暴露成本投影入口");
  assert.equal(toolset.getTeamState, undefined);
});

test("enabled=true：暴露 getTeamState，经 TeamCreate 建成员后实时可见（绑定 controller 实例）", async () => {
  const toolset = createTeamToolset({
    enabled: true,
    codingTools: [],
    defaultModel: fakeModel(),
    getGate: () => undefined,
  });
  assert.equal(typeof toolset.getTeamState, "function", "默认开启时必须暴露成本投影入口");
  assert.equal(toolset.getTeamState().members.size, 0, "尚未 spawn 成员时团队为空");

  // 走真实工具出口（TeamCreate 的 execute 是纯内存态操作，不触达模型与 IO）：
  // 若 getTeamState 只是「创建时的空快照」，这里就读不到 bull，说明引用被丢弃了。
  const create = toolset.tools.find((tool) => tool.name === "TeamCreate");
  assert.ok(create, "工具表必须含 TeamCreate");
  await create.execute("tc_1", {
    name: "bull",
    role: "看涨分析师",
    allowedTools: ["read"],
    task: "分析 AAPL",
  });

  const state = toolset.getTeamState();
  assert.equal(state.members.size, 1, "TeamCreate 之后 getTeamState 必须能看到成员");
  assert.equal(state.members.get("bull")?.role, "看涨分析师");
});

// G-T1 接线的最后一跳（web-host → serve）：hostOhnaWeb 必须把 getTeamState 透传进
// createOhnaServer，否则 team-wiring 暴露的入口在 CLI 单一形态下等于断路。
//
// 说明：这里起的是真实 serve 实例（最小 active = stub 模型 + 假 key，不联网），但 hostOhnaWeb
// 目前不透传 streamFn（既有缺口，本任务范围外），因此 run 会因为没有真实 provider 凭据而失败。
// 断言只锁定「透传链路成立」这一件事：run 终态后 cost_summary 里出现与 projectTeamCostSummary
// 完全一致的 team 段——若 web-host 丢了 getTeamState，该段必然缺失。
test("web-host：getTeamState 透传到 serve，run 收尾产出 team 成本段", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-team-wiring-host-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const model = fakeModel();
  const teamState = {
    members: new Map([
      [
        "bull",
        {
          name: "bull",
          role: "看涨分析师",
          model,
          status: "done",
          allowedTools: [],
          summary: "看涨",
          usage: { tokens: 42, cost: 0.00042 },
          durationMs: 120,
        },
      ],
    ]),
    inboundQueues: new Map(),
    events: [],
  };

  const hosted = await hostOhnaWeb({
    workspaceRoot,
    active: { model, apiKey: "test-key", profile: "test" },
    tools: [],
    autoApprove: true,
    observeOnly: false,
    port: 0,
    conversationTitle: "team-wiring 透传",
    dataDir: path.join(root, "data"),
    // 时序与生产一致：serve 在 run 开始（costTracker.begin）给团队用量打基线，
    // 收尾只报**本 run 增量**。因此成员必须在 createRun 返回之后才「出现」——
    // 若在 run 开始前就存在，会被正确判定为历史 run 的用量而被剔除。
    getTeamState: () => liveTeamState,
  });
  let liveTeamState = { members: new Map(), inboundQueues: new Map(), events: [] };
  try {
    assert.ok(hosted, "serve 装配失败（端口/数据目录）——透传用例无法成立");
    const { server } = hosted;
    const conversation = await server.createConversation("team 透传");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "请让团队分析一下",
    });
    // run 已建立（基线已快照），此时模拟本 run 内 TeamCreate 创建成员并跑完。
    liveTeamState = teamState;

    // 等终态（无论 completed 还是 failed，收尾都会发 cost_summary）。
    let terminal = false;
    for (let attempt = 0; attempt < 200 && !terminal; attempt += 1) {
      const snapshot = (await server.app.inject({
        method: "GET",
        url: created.accepted.snapshotUrl,
      })).json().data;
      terminal = ["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status);
      if (!terminal) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(terminal, "run 必须进入终态");

    const sse = await server.app.inject({ method: "GET", url: created.accepted.eventsUrl });
    assert.equal(sse.statusCode, 200);
    const events = sse.body
      .split("\n\n")
      .filter((frame) => frame.includes("event: run_event"))
      .map((frame) =>
        JSON.parse(
          frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n"),
        ),
      );
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.ok(costSummary, "run 收尾必须产出 cost_summary");
    const expected = projectTeamCostSummary(teamState);
    assert.deepEqual(costSummary.payload.team, expected);
  } finally {
    await hosted?.server.shutdown().catch(() => undefined);
    await hosted?.server.close().catch(() => undefined);
    releaseHost();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v2.0（docs/v2.0/04 §2.2 / §7 第 1 步）：Team 装配上移到 serve，CLI 只保留开关。
// 下面这条用例走**真实入口** `hostOhnaWeb`（生产 CLI 的同一条路径），验证：
//   1. CLI 不再自建 controller —— 工具表里没有 CLI 侧的 TeamCreate；
//   2. `team: true` 透传后，serve 侧 controller 真的能 spawn 子代理（子代理边界事件进事件流）；
//   3. 团队成本段来自 serve 的 controller（`team` 段有非零用量的成员）。
// 桩只替换 StreamFn（adapter 位置），真实 `agentLoop` / confirm-gate / 事件流全在跑。
// ---------------------------------------------------------------------------

/**
 * 脚本化 streamFn：按「最后一条消息是否为 toolResult」推进 supervisor，子代理轮直接收尾。
 *
 * @param from {toolNames} 首轮可用的工具名快照（断言用）。
 * @returns StreamFn。
 */
function createTeamScriptStream(snapshot) {
  return (_model, context) => {
    const tools = (context.tools ?? []).map((tool) => tool.name);
    snapshot.toolNames = tools;
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];
    const toolResult =
      last?.role === "toolResult"
        ? last.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
        : undefined;
    const stream = createAssistantMessageEventStream();
    const message = (content, stopReason) => ({
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "mock",
      model: "mock-model",
      usage: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason,
      timestamp: Date.now()
    });
    const push = (msg) => {
      stream.push({ type: "start", partial: { ...msg, content: [] } });
      for (const [contentIndex, block] of msg.content.entries()) {
        if (block.type === "text") {
          stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: msg });
        } else {
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: msg });
        }
      }
      stream.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg });
    };
    queueMicrotask(() => {
      if (toolResult === undefined && tools.includes("TeamCreate")) {
        push(message([{ type: "toolCall", id: "c1", name: "TeamCreate", arguments: { name: "bull", role: "看涨分析师", tools: [] } }], "toolUse"));
      } else if (toolResult?.includes("已创建成员")) {
        push(message([{ type: "toolCall", id: "c2", name: "SendMessage", arguments: { recipient: "bull", content: "给出看涨理由" } }], "toolUse"));
      } else {
        push(message([{ type: "text", text: "分析完成。" }], "stop"));
      }
    });
    return stream;
  };
}

test("v2.0：CLI 形态（--team）下 serve 侧 Team 真的可 spawn 子代理，且只有一份 controller", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-team-cli-serve-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const model = fakeModel();
  const snapshot = {};
  const hosted = await hostOhnaWeb({
    workspaceRoot,
    active: { model, apiKey: "test-key", profile: "test" },
    // CLI 不再把 Team 工具塞进工具表：这里刻意传**空**工具表，TeamCreate 只能来自 serve。
    tools: [],
    autoApprove: true,
    observeOnly: false,
    port: 0,
    conversationTitle: "CLI Team 验收",
    dataDir: path.join(root, "data"),
    team: true,
    streamFn: createTeamScriptStream(snapshot),
  });
  try {
    assert.ok(hosted, "serve 装配失败 —— 本验收无法成立");
    const { server } = hosted;
    const conversation = await server.createConversation("CLI Team");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "让团队分析",
    });
    let terminal = false;
    for (let attempt = 0; attempt < 300 && !terminal; attempt += 1) {
      const snap = (await server.app.inject({ method: "GET", url: created.accepted.snapshotUrl })).json().data;
      terminal = ["completed", "failed", "cancelled", "interrupted"].includes(snap?.status);
      if (!terminal) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(terminal, "run 必须进入终态");

    // 1) TeamCreate / SendMessage 由 serve 侧 controller 提供（CLI 传入的工具表是空的）。
    assert.ok(snapshot.toolNames.includes("TeamCreate"), "serve 侧必须并入 TeamCreate");
    assert.ok(snapshot.toolNames.includes("SendMessage"), "serve 侧必须并入 SendMessage");

    const events = (await server.app.inject({ method: "GET", url: created.accepted.eventsUrl })).body
      .split("\n\n")
      .filter((frame) => frame.includes("event: run_event"))
      .map((frame) => JSON.parse(frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")));

    // 2) 子代理边界事件真的进了 run 事件流（spawn 成功）。
    const subStart = events.find((event) => event.type === "agent_start" && event.payload.agentId === "bull");
    assert.ok(subStart, "子代理 bull 的 agent_start 必须出现在事件流");
    assert.equal(subStart.payload.parentId, "supervisor");

    // 3) 团队成本段来自 serve 的 controller，且用量非零（证明 member.usage 回写链路成立）。
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.ok(costSummary?.payload.team, "必须产出 cost_summary.payload.team");
    const member = costSummary.payload.team.members.find((entry) => entry.name === "bull");
    assert.ok(member, "team 段必须包含 bull");
    assert.ok(member.tokens > 0, `无上限 budget 只用于触发用量回写，tokens 必须 > 0，实际 ${member.tokens}`);
  } finally {
    // 与上面既有用例同一清理方式：releaseHost 只复位 hosting 标志，不关 server。
    await hosted?.server.shutdown().catch(() => undefined);
    await hosted?.server.close().catch(() => undefined);
    releaseHost();
    await fs.rm(root, { recursive: true, force: true });
  }
});
