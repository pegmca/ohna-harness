/**
 * T-L2b：编排机契约（mock 工具副作用 + 真 provider 驱动）——
 * docs/v2.0/03-team-eval.md §6.3「真 provider 最小回放」。
 *
 * 红线边界（§4）：
 * - **不 mock 模型输出**：`streamFn` 直通 `@aiagent/ai` 的 `streamSimple`（见 team-l2b-provider-fixture.mjs），
 *   绝无预置 assistant 消息回放。
 * - **允许 mock 工具副作用**：`write` / `bash` 的 `execute` 返回固定值并记录调用，不落盘、不跑子进程。
 * - **断言只指控制流**：status / summary 非空 / 状态回写 / 「工具通道被调用过」这个事实；
 *   不断言模型给出什么内容、该不该调用哪个工具（那是 L4 judge 的职责）。
 *
 * 无凭据时（本仓库 CI 环境即如此）**显式 skip 并写明原因**，绝不静默通过；
 * 硬门禁的确定性面由 L1 纯函数承担（team-l2b-kernel.test.mjs / team-pure*.test.mjs），
 * 因此这里的 skip 不会让任何门禁失去意义。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createTeamController } from "../dist/team-controller.js";
import { projectTeamCostSummary } from "../dist/team/run-event.js";
import { createRealStreamFn, detectRealProvider } from "./team-l2b-provider-fixture.mjs";

// 单请求超时：真实 provider 不可达时让用例尽快以结构化失败收尾，而不是挂满 10 分钟缺省超时。
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 构造一个「副作用已 mock」的工具。真 provider 若决定调用它，副作用被拦在测试内。
 *
 * @param name 工具名。
 * @param calls 调用记录数组。
 * @param effect 副作用声明（沿用生产工具的语义）。
 * @param delayMs 人造延迟（毫秒），用于并发在飞观测；0 表示立即返回。
 * @returns AgentTool。
 */
function createMockedTool(name, calls, effect, delayMs = 0) {
  return {
    name,
    description: `${name}（L2b 测试用：execute 副作用被 mock，不产生真实副作用）`,
    label: name,
    parameters: z.object({ path: z.string().optional(), command: z.string().optional(), content: z.string().optional() }),
    effect,
    async execute(_toolCallId, params) {
      calls.push({ name, params });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: "text", text: `${name}:mocked-ok` }], details: { mocked: true } };
    },
  };
}

/**
 * 断言一次子代理运行的控制流结果「形状合法」——对任意合理模型输出都成立。
 *
 * @param result SubagentResult。
 * @param memberName 成员名。
 * @returns void（失败即抛断言错误）。
 */
function assertControlFlowResult(result, memberName) {
  assert.equal(result.member, memberName);
  assert.ok(result.status === "done" || result.status === "failed", `status 应为 done|failed，实际 ${result.status}`);
  assert.ok(Array.isArray(result.artifacts), "artifacts 必须是数组");
  if (result.status === "done") {
    // 摘要回收走通：模型给出任意文本都应是非空字符串。
    assert.equal(typeof result.summary, "string");
    assert.ok(result.summary.length > 0, "done 时摘要不应为空");
    assert.equal(result.error, undefined);
  } else {
    // 失败隔离走通：失败必须携带结构化错误，而不是抛异常。
    assert.ok(result.error, "failed 时必须有结构化 error");
    assert.equal(typeof result.error.code, "string");
    assert.equal(typeof result.error.message, "string");
  }
}

test("[L2b] 真 provider 驱动最小委派：控制流走通 + 状态回写 + 工具通道为 mock", async (t) => {
  const probe = detectRealProvider();
  if (!probe.active) return t.skip(probe.reason);

  const calls = [];
  const controller = createTeamController({
    defaultModel: probe.active.model,
    streamFn: createRealStreamFn(probe.active, { maxTokens: 64, timeoutMs: REQUEST_TIMEOUT_MS }),
    // 工具副作用出口全部 mock（§4.1 允许）；真模型即便决定调用也零污染。
    availableTools: [
      createMockedTool("write", calls, "mutate"),
      createMockedTool("edit", calls, "mutate"),
      createMockedTool("bash", calls, "mutate"),
    ],
    maxConcurrentMembers: 2,
    budget: { maxCostPerMember: 0.2, maxTokensPerMember: 20_000 },
  });
  await controller.createMember({ name: "analyst", role: "研究员", tools: ["write", "edit", "bash"] });

  // 唯一输入是委派文本；不给任何「必须调用某工具」的暗示（那会变成测决策）。
  const result = await controller.runMember("analyst", "用一句话说明什么是上下文隔离。");
  assertControlFlowResult(result, "analyst");

  const state = controller.getTeamState();
  const member = state.members.get("analyst");
  // 状态机回写（§6.3 第 3 条）：终态 + 摘要/产物 + 墙钟时延。
  assert.equal(member.status, result.status);
  assert.equal(typeof member.durationMs, "number");
  assert.ok(Number.isFinite(member.durationMs) && member.durationMs >= 0, "成员时延应为有限非负数");
  if (result.status === "done") assert.equal(member.summary, result.summary);
  // 派发链路事件顺序：入队 → 启动 → 收尾（成功或失败）。
  const types = state.events.map((e) => e.type);
  assert.ok(types.includes("message_sent"));
  assert.ok(types.includes("member_started"));
  assert.ok(types.includes("member_completed") || types.includes("member_failed"));
  assert.equal(state.inboundQueues.get("analyst").length, 1);

  // 工具通道观测：只断言「若模型调用了工具，它走的是 mock 出口」这个事实。
  // 不断言调用次数 > 0（模型可能纯文本收敛），也不断言参数内容（那属于决策）。
  for (const call of calls) {
    assert.ok(["write", "edit", "bash"].includes(call.name));
  }
  if (calls.length > 0) {
    // 走通 mock 出口的证据：mock 的固定返回会以产物形式回收到 artifacts（extractSummary 的产物面）。
    assert.ok(
      result.artifacts.some((artifact) => artifact.startsWith(`${calls[0].name}:`)),
      `若工具被调用，artifacts 应记录 ${calls[0].name} 的产物`,
    );
  }
});

test("[L2b] 真 provider 下的失败隔离或成功收尾：SendMessage 不抛异常，supervisor 可继续", async (t) => {
  const probe = detectRealProvider();
  if (!probe.active) return t.skip(probe.reason);

  const calls = [];
  const controller = createTeamController({
    defaultModel: probe.active.model,
    streamFn: createRealStreamFn(probe.active, { maxTokens: 32, timeoutMs: REQUEST_TIMEOUT_MS }),
    availableTools: [createMockedTool("bash", calls, "mutate")],
  });
  await controller.createMember({ name: "runner", role: "执行者", tools: ["bash"] });

  const tool = controller.tools.find((item) => item.name === "SendMessage");
  assert.ok(tool);

  // 不 assert.rejects：SendMessage 的设计就是「失败以可读文本 + isError:false 回传」。
  const outcome = await tool.execute("call-1", { recipient: "runner", content: "回一句你好。" });
  assert.equal(typeof outcome.content[0].text, "string");
  assertControlFlowResult(outcome.details, "runner");

  // supervisor 主循环未崩溃：状态查询与视图渲染仍可用。
  assert.doesNotThrow(() => controller.getTeamView());
  assert.match(controller.getTeamView(), /runner \[(done|failed)\]/);
});

test("[L2b] 真 provider + mock 慢工具：并发在飞峰值不超过 maxConcurrentMembers", async (t) => {
  const probe = detectRealProvider();
  if (!probe.active) return t.skip(probe.reason);

  // 在飞计数不依赖模型输出：成员运行期间都持有信号量许可，用时间窗内的峰值观测。
  let inFlight = 0;
  let peak = 0;
  const controller = createTeamController({
    defaultModel: probe.active.model,
    streamFn: createRealStreamFn(probe.active, { maxTokens: 32, timeoutMs: REQUEST_TIMEOUT_MS }),
    availableTools: [createMockedTool("write", [], "mutate")],
    maxConcurrentMembers: 2,
  });
  for (const name of ["a", "b", "c", "d"]) {
    await controller.createMember({ name, role: "成员" });
  }

  // 观测器：每个成员 runMember 的 Promise 在飞期间 +1（Promise 在 finally 归位），
  // 与 controller 内部信号量同生命周期，因此峰值直接反映并发约束。
  const origin = controller.runMember.bind(controller);
  let wrappedPeak = 0;
  controller.runMember = async (...args) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    wrappedPeak = Math.max(wrappedPeak, peak);
    try {
      return await origin(...args);
    } finally {
      inFlight--;
    }
  };

  const results = await controller.runMembers(["a", "b", "c", "d"], "回一句你好。", 4);
  assert.equal(results.length, 4);
  for (const result of results) assertControlFlowResult(result, result.member);
  assert.ok(wrappedPeak <= 2, `在飞峰值 ${wrappedPeak} 应 <= maxConcurrentMembers(2)`);
  // controller 自身的观测通道同样记录在飞峰值（projectTeamCostSummary 的容量证据来源）。
  const summary = projectTeamCostSummary(controller.getTeamState());
  if (summary.peakConcurrency !== undefined) {
    assert.ok(summary.peakConcurrency <= 2, `peakConcurrency ${summary.peakConcurrency} 应 <= 2`);
  }
});
