/**
 * F-7 直通命令：`!` 必须经过权限闸门（block 时零执行），`#` 写入 AGENTS.md。
 *
 * bash 工具用假实现：测试只关心「是否执行 / 是否过闸门」，真实命令执行已在 coding 包覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setOutputSink } from "../dist/render.js";
import { createUsageTracker } from "../dist/usage.js";
import { handleDirectInput, runBashDirect } from "../dist/direct-command.js";

/** 捕获输出。 */
const output = [];
setOutputSink((text) => output.push(text));

/**
 * 取出并清空捕获输出。
 *
 * @returns 拼接文本。
 */
function takeOutput() {
  return output.splice(0, output.length).join("");
}

/**
 * 构造直通上下文。
 *
 * @param dir 工作区。
 * @param tools 工具表。
 * @param beforeToolCall 可选闸门。
 * @returns 上下文。
 */
function makeContext(dir, tools, beforeToolCall) {
  return {
    cwd: dir,
    tools,
    history: [],
    setup: { systemPrompt: "", autoApprove: false, cwd: dir, summarizer: async () => "" },
    tracker: createUsageTracker(),
    ...(beforeToolCall ? { beforeToolCall } : {}),
  };
}

/**
 * 假 bash 工具：记录执行次数与参数。
 *
 * @param executed 执行记录数组。
 * @returns AgentTool 形状对象。
 */
function makeBash(executed) {
  return {
    name: "bash",
    label: "Bash",
    description: "fake",
    parameters: { parse: (value) => value },
    async execute(_id, params) {
      executed.push(params);
      return { content: [{ type: "text", text: `ran ${params.command}` }], details: {} };
    },
  };
}

test("runBashDirect：闸门 block 时不执行命令", async () => {
  const executed = [];
  const seen = [];
  const ctx = makeContext("/tmp/ohna-direct", [makeBash(executed)], async (call) => {
    seen.push(call);
    return { block: true, reason: "测试拒绝" };
  });
  takeOutput();
  await runBashDirect("rm -rf /", ctx);
  const text = takeOutput();
  assert.equal(executed.length, 0, "被拒绝时不得调用 execute");
  assert.match(text, /已拒绝执行：测试拒绝/);
  assert.equal(seen[0].toolCall.name, "bash");
  assert.deepEqual(seen[0].args, { command: "rm -rf /" });
});

test("runBashDirect：闸门放行后执行一次并渲染结果", async () => {
  const executed = [];
  const ctx = makeContext("/tmp/ohna-direct", [makeBash(executed)], async () => undefined);
  takeOutput();
  await runBashDirect("echo hi", ctx);
  const text = takeOutput();
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0], { command: "echo hi" });
  assert.match(text, /bash\(echo hi\)/);
  assert.match(text, /ran echo hi/);
});

test("handleDirectInput：! 空命令提示用法；普通文本返回 false", async () => {
  const ctx = makeContext("/tmp/ohna-direct", [makeBash([])]);
  takeOutput();
  assert.equal(await handleDirectInput("!", ctx), true);
  assert.match(takeOutput(), /用法：!<bash 命令>/);
  assert.equal(await handleDirectInput("你好", ctx), false);
  // `#` 后必须跟空白才是记忆；`#include` 是普通文本。
  assert.equal(await handleDirectInput("#include <stdio.h>", ctx), false);
});

test("handleDirectInput：plan 模式拒绝 # 写入", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-direct-"));
  try {
    const ctx = makeContext(dir, [makeBash([])]);
    ctx.getPermissionPreset = () => "plan";
    takeOutput();
    assert.equal(await handleDirectInput("# 不该写入", ctx), true);
    assert.match(takeOutput(), /plan 模式禁止写入/);
    await assert.rejects(readFile(path.join(dir, "AGENTS.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleDirectInput：# 追加 AGENTS.md 并刷新系统提示词", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-direct-"));
  try {
    const ctx = makeContext(dir, [makeBash([])]);
    takeOutput();
    assert.equal(await handleDirectInput("# 验证用 pnpm typecheck", ctx), true);
    const text = takeOutput();
    assert.match(text, /已记录到 .*AGENTS\.md；下一轮生效/);
    const agents = await readFile(path.join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /- 验证用 pnpm typecheck/);
    assert.ok(ctx.setup.systemPrompt.length > 0, "应重新解析系统提示词");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
