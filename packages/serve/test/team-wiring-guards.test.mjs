/**
 * W2（docs/v2.0/04 §2.2）· serve Team 接线的**权限与并发域**验收。
 *
 * 覆盖：run 终态后子代理的 mutating 工具被拒而非静默放行（fail-closed）；并发 run 时
 * `release` 只摘自己的绑定、不串到别人的事件流；以及 provider 全链路（仅替换 fetch）下
 * 子代理 `llm_call.agentId` 穿过 `buildBaseOptions` 仍然成立。
 *
 * 夹具见 `team-wiring-fixture.mjs`；事件归属见 `team-wiring-events.test.mjs`。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createCodingToolRegistry } from "@aiagent/coding";
import { SUPERVISOR_AGENT_ID } from "@aiagent/agent";
import { createOhnaServer } from "../dist/index.js";
import { createServeTeamSession } from "../dist/run/team-session.js";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createTransportStubbedStreamFn, sseResponse, textChunks } from "../../agent/test/transport-stub.mjs";
import {
  MODEL,
  assistantMessage,
  pushMessage,
  createPlainTextStream,
  createTeamScriptStream,
  createTestServer,
  dispose,
  parseSseEvents,
  waitForTerminal
} from "./team-wiring-fixture.mjs";

test("[v2.0] release 之后子代理的 mutating 工具被拒而非静默放行（fail-closed）", async () => {
  // 时序：`RunManager.execute` 在 continueRun 返回后才 release；`cancel()` / `shutdown()`
  // 的兜底会把 run 标记终态，此时子代理可能仍在飞。该路径下 run 注册表已空，子代理的
  // beforeToolCall 必须命中 fail-closed 分支——这是**预期**行为（宁可失败不越权）。
  //
  // 为什么要给一个 mutate 工具：子代理若只回文本就会「成功结束」，从而掩盖闸门失效；
  // 只有真的发一次写操作，才能观测到 block 是否生效。
  // 直接复用编码工具集里的真实 write（effect: "mutate"、zod schema 齐全），
  // 不在这里手工造工具——工具契约的细节（label / zod）会喧宾夺主。
  const writeTool = createCodingToolRegistry(os.tmpdir()).find((tool) => tool.name === "write");
  assert.ok(writeTool, "编码工具集必须提供 write");
  // 子代理脚本：先调 write，拿到工具结果后收尾（这样 block 与否都走完整链路）。
  const streamFn = (_model, context) => {
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (last?.role !== "toolResult") {
        pushMessage(
          stream,
          assistantMessage(
            [
              {
                type: "toolCall",
                id: "w1",
                name: "write",
                // 参数必须通过 write 的 zod 校验（path + content 均必填），否则测到的是校验失败
                // 而不是权限闸门——两者都会「失败」，但只有后者能证明 fail-closed 生效。
                arguments: { path: path.join(os.tmpdir(), "ohna-fail-closed-probe.txt"), content: "x" }
              }
            ],
            "toolUse"
          )
        );
        return;
      }
      pushMessage(stream, assistantMessage([{ type: "text", text: "结束" }], "stop"));
    });
    return stream;
  };
  const session = createServeTeamSession({
    model: MODEL,
    streamFn,
    window: {
      contextWindow: MODEL.contextWindow,
      maxTokens: MODEL.maxTokens,
      reserveTokens: 1024
    },
    tools: [writeTool]
  });
  const events = [];
  const turn = session.beginTurn(
    { runId: "run-a", emit: (event) => events.push(event), emitLlmCall: () => {} },
    [writeTool]
  );
  turn.release();
  turn.release(); // 幂等

  const create = session.teamTools.find((tool) => tool.name === "TeamCreate");
  await create.execute("c1", { name: "ghost", role: "幽灵", tools: ["write"] });
  const send = session.teamTools.find((tool) => tool.name === "SendMessage");
  const result = await send.execute("c2", { recipient: "ghost", content: "动手改文件" });

  // release 之后连边界事件都不再投递（没有 run 承接），观测出口已断开——预期。
  assert.deepEqual(events, [], "release 后不投递任何子代理事件");
  // 子代理的写操作必须被闸门**拒绝**，而不是静默放行：
  // 拒绝原因以结构化产物形式回喂给 supervisor（artifacts[].detail），
  // 且绝不应出现 write 成功落盘的痕迹。子代理自身仍可能以 done 收尾（它只是收到了
  // 一个「被拒绝」的工具结果），因此判定依据是产物里的拒绝原因，而非 status。
  const artifacts = JSON.stringify(result.details.artifacts);
  assert.match(artifacts, /权限闸门未就绪/, "写操作必须被 fail-closed 拒绝并回喂结构化原因");
  assert.doesNotMatch(artifacts, /written|写入成功/, "写操作不得真正执行");
});

test("[v2.0] 并发 run：release 只摘自己的绑定，不串到别人的事件流", async () => {
  const session = createServeTeamSession({
    model: MODEL,
    streamFn: createPlainTextStream(),
    window: {
      contextWindow: MODEL.contextWindow,
      maxTokens: MODEL.maxTokens,
      reserveTokens: 1024
    }
  });
  const runA = [];
  const runB = [];
  const turnA = session.beginTurn(
    { runId: "run-a", emit: (event) => runA.push(event), emitLlmCall: () => {} },
    []
  );
  const turnB = session.beginTurn(
    { runId: "run-b", emit: (event) => runB.push(event), emitLlmCall: () => {} },
    []
  );

  // A 先结束：只摘 A 自己那一项，B 的绑定必须仍在（否则 B 的子代理事件会丢失）。
  turnA.release();
  const create = session.teamTools.find((tool) => tool.name === "TeamCreate");
  await create.execute("c1", { name: "worker", role: "执行者", tools: [] });
  const send = session.teamTools.find((tool) => tool.name === "SendMessage");
  await send.execute("c2", { recipient: "worker", content: "汇报" });

  assert.deepEqual(runA, [], "A 已 release，任何子代理事件都不该投进 A");
  assert.ok(
    runB.some((event) => event.type === "agent_start" && event.agentId === "worker"),
    "B 仍在活跃，子代理事件必须投进 B"
  );
  // 再释放 B 后事件完全静默。
  turnB.release();
  const before = runB.length;
  await send.execute("c3", { recipient: "worker", content: "再汇报" });
  assert.equal(runB.length, before, "全部 release 后不再有事件投递");
});

test("[v2.0] provider 链路（仅替换 fetch）：子代理 llm_call 的 agentId 穿过 buildBaseOptions 仍成立", async () => {
  // 与前几条用例不同的手法：这里让**真实** `streamSimple` 跑完整 provider 链路，
  // 只把 HTTP fetch 换成本地桩（回放 SSE 字节）。这样能验证本工作项最关键的一条：
  // `observer.agentId` 由 wrapper 在**调用入口**读取，而 wrapper 内部传给 adapter 的
  // `chainedOptions` 会被 `buildBaseOptions` 逐字段重建（observer 被丢弃）——
  // 因此身份必须由外层的薄转发写好，而不是指望它穿到 adapter。
  const requests = [];
  const baseStreamFn = createTransportStubbedStreamFn(async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    requests.push(payload);
    // 依据请求内容决定这一轮说什么：子代理（system prompt 含「团队成员」）直接收尾；
    // supervisor 先 TeamCreate，再 SendMessage，最后收尾。用一个计数器区分 supervisor 轮次。
    const system = String(payload.messages?.[0]?.content ?? "");
    const isSubagent = system.includes("团队成员");
    if (isSubagent) return sseResponse(textChunks("子代理完成", undefined, MODEL.id));
    const supervisorTurns = requests.filter((entry) => !String(entry.messages?.[0]?.content ?? "").includes("团队成员")).length;
    if (supervisorTurns === 1) {
      return sseResponse([
        {
          id: "c-1",
          model: MODEL.id,
          choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }]
        },
        {
          id: "c-1",
          model: MODEL.id,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_create",
                    type: "function",
                    function: { name: "TeamCreate", arguments: JSON.stringify({ name: "analyst", role: "分析师", tools: [] }) }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        },
        { id: "c-1", model: MODEL.id, choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      ]);
    }
    if (supervisorTurns === 2) {
      return sseResponse([
        {
          id: "c-1",
          model: MODEL.id,
          choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }]
        },
        {
          id: "c-1",
          model: MODEL.id,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_send",
                    type: "function",
                    function: { name: "SendMessage", arguments: JSON.stringify({ recipient: "analyst", content: "分析" }) }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        },
        { id: "c-1", model: MODEL.id, choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      ]);
    }
    return sseResponse(textChunks("完成", undefined, MODEL.id));
  });

  const session = createServeTeamSession({
    model: MODEL,
    streamFn: baseStreamFn,
    window: {
      contextWindow: MODEL.contextWindow,
      maxTokens: MODEL.maxTokens,
      reserveTokens: 1024
    }
  });
  const records = [];
  const events = [];
  const turn = session.beginTurn(
    { runId: "run-p", emit: (event) => events.push(event), emitLlmCall: (record) => records.push(record) },
    []
  );
  try {
    const create = session.teamTools.find((tool) => tool.name === "TeamCreate");
    await create.execute("c1", { name: "analyst", role: "分析师", tools: [] });
    const send = session.teamTools.find((tool) => tool.name === "SendMessage");
    const result = await send.execute("c2", { recipient: "analyst", content: "分析" });
    assert.equal(result.details.status, "done", "provider 链路下的子代理必须成功");

    // 请求真的经过了 provider adapter（有 HTTP 往返），不是 adapter 位置桩。
    assert.ok(requests.length >= 1, "必须真的发出 provider 请求");
    // 子代理的 llm_call 归因到成员：证明 agentId 没在 buildBaseOptions 里被丢掉。
    const subagentRecord = records.find((record) => record.agentId === "analyst");
    assert.ok(subagentRecord, `子代理记录必须带成员身份，实际记录：${records.map((r) => r.agentId).join(",")}`);
    // window 同样随记录落盘（构造期注入，与走不走 provider 无关）。
    assert.equal(subagentRecord.window.contextWindow, MODEL.contextWindow);
  } finally {
    turn.release();
  }
});
