/**
 * CLI 权限模式与三选项解析单测。
 *
 * 覆盖：
 * - AskAdapter 回答解析（1/2/3、y/n、空串与非法输入的拒绝兜底）；
 * - Shift+Tab 循环顺序 default → acceptEdits → plan → default（bypass 退出）；
 * - `/permissions mode` 的名称解析与状态文案。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createToolConfirmGate, parsePermissionAnswer } from "../dist/permission/confirm.js";
import {
  formatPermissionStatus,
  nextPermissionPreset,
  parsePermissionPreset
} from "../dist/permission/permission-mode.js";
import { createPermissionSession } from "../dist/permission/permission-session.js";

test("parsePermissionAnswer：1/2/3 与 y/n 映射", () => {
  assert.equal(parsePermissionAnswer("1"), "allow");
  assert.equal(parsePermissionAnswer("y"), "allow");
  assert.equal(parsePermissionAnswer("YES"), "allow");
  assert.equal(parsePermissionAnswer("2"), "allow-session");
  assert.equal(parsePermissionAnswer("3"), "deny");
  assert.equal(parsePermissionAnswer("n"), "deny");
  assert.equal(parsePermissionAnswer("no"), "deny");
});

test("parsePermissionAnswer：空串与非法输入按拒绝兜底", () => {
  assert.equal(parsePermissionAnswer(""), "deny");
  assert.equal(parsePermissionAnswer("   "), "deny");
  assert.equal(parsePermissionAnswer("maybe"), "deny");
  assert.equal(parsePermissionAnswer("9"), "deny");
});

test("nextPermissionPreset：default → acceptEdits → plan → default", () => {
  assert.equal(nextPermissionPreset("default"), "acceptEdits");
  assert.equal(nextPermissionPreset("acceptEdits"), "plan");
  assert.equal(nextPermissionPreset("plan"), "default");
  // bypass 不在循环内：按一次回到 default（显式退出全放行）。
  assert.equal(nextPermissionPreset("bypass"), "default");
});

test("parsePermissionPreset：大小写不敏感，非法返回 null", () => {
  assert.equal(parsePermissionPreset("default"), "default");
  assert.equal(parsePermissionPreset("acceptEdits"), "acceptEdits");
  assert.equal(parsePermissionPreset("ACCEPTEDITS"), "acceptEdits");
  assert.equal(parsePermissionPreset("plan"), "plan");
  assert.equal(parsePermissionPreset("bypass"), "bypass");
  assert.equal(parsePermissionPreset("nope"), null);
});

test("formatPermissionStatus：展示当前模式与会话规则", () => {
  const empty = formatPermissionStatus("default", []);
  assert.match(empty, /当前权限模式：default/);
  assert.match(empty, /会话规则：\n {2}无/);

  const withRules = formatPermissionStatus("acceptEdits", [
    { toolName: "write", target: "a.txt" },
    { toolName: "bash" }
  ]);
  assert.match(withRules, /write：a\.txt/);
  assert.match(withRules, /bash（全部）/);
});

test("PermissionSession：plan 模式只暴露只读工具，切回后恢复完整工具表", () => {
  const tools = [
    { name: "read", effect: "read" },
    { name: "write", effect: "mutate" },
    { name: "mcp_unknown" }
  ];
  const session = createPermissionSession({ autoApprove: false, tools });
  assert.equal(session.preset(), "default");
  assert.deepEqual(session.activeTools().map((tool) => tool.name), ["read", "write", "mcp_unknown"]);

  assert.match(session.cycle(), /acceptEdits/);
  assert.match(session.cycle(), /plan/);
  assert.equal(session.preset(), "plan");
  // 未标注 effect 的 MCP 工具按 mutate 处理，plan 下同样不注册。
  assert.deepEqual(session.activeTools().map((tool) => tool.name), ["read"]);

  assert.match(session.cycle(), /default/);
  assert.deepEqual(session.activeTools().map((tool) => tool.name), ["read", "write", "mcp_unknown"]);
});

test("PermissionSession：/permissions 支持 mode 与 clear", () => {
  const session = createPermissionSession({ autoApprove: true, tools: [] });
  assert.equal(session.preset(), "bypass");

  assert.match(session.handleCommand(""), /当前权限模式：bypass/);
  assert.match(session.handleCommand("mode acceptedits"), /已切换权限模式：acceptEdits/);
  assert.equal(session.preset(), "acceptEdits");
  assert.match(session.handleCommand("mode nope"), /用法/);

  session.state.allow("write", "a.txt");
  assert.match(session.handleCommand(""), /write：a\.txt/);
  assert.match(session.handleCommand("clear"), /已清空/);
  assert.deepEqual(session.state.rules(), []);
});

test("PermissionSession：reset 清空会话规则但保留当前 preset", () => {
  const session = createPermissionSession({ autoApprove: false, tools: [] });
  session.state.allow("write", "a.txt");
  session.state.allow("bash");
  assert.equal(session.state.rules().length, 2);

  assert.match(session.cycle(), /acceptEdits/);
  session.reset();

  assert.deepEqual(session.state.rules(), []);
  assert.equal(session.preset(), "acceptEdits", "reset 只清规则，不重置用户当前模式");
});

test("--yes 日志随实时 preset 漂移：切到 default 后不再打印自动放行并进入 ask", async () => {
  let preset = "bypass";
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const gate = createToolConfirmGate({
      autoApprove: true,
      cwd: "/tmp/ohna",
      getPreset: () => preset
    });
    const context = {
      assistantMessage: { role: "assistant", content: [], timestamp: 0 },
      toolCall: { type: "toolCall", id: "c3", name: "write", arguments: { path: "a.txt" } },
      args: { path: "a.txt" },
      context: {
        systemPrompt: "",
        messages: [],
        tools: [{ name: "write", effect: "mutate" }]
      }
    };

    // bypass：打印自动放行且直接放行。
    assert.equal(await gate(context), undefined);
    assert.match(chunks.join(""), /--yes 自动放行/);

    // 实时切到 default：同一钩子不得再打印自动放行，并进入 ask（非 TTY → 拒绝）。
    chunks.length = 0;
    preset = "default";
    const result = await gate(context);
    assert.equal(result?.block, true);
    assert.doesNotMatch(chunks.join(""), /--yes 自动放行/);
    assert.match(chunks.join(""), /非交互环境/, "应进入 ask 分支");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("非 TTY 默认拒绝：mutating 工具返回 block（不悬挂等待输入）", async () => {  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const gate = createToolConfirmGate({ autoApprove: false, cwd: "/tmp/ohna" });
    const result = await gate({
      assistantMessage: { role: "assistant", content: [], timestamp: 0 },
      toolCall: { type: "toolCall", id: "c1", name: "write", arguments: { path: "a.txt" } },
      args: { path: "a.txt" },
      context: {
        systemPrompt: "",
        messages: [],
        tools: [{ name: "write", effect: "mutate" }]
      }
    });
    assert.equal(result?.block, true);
    assert.match(result.reason, /用户拒绝/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

/**
 * 临时把 stdin 伪装成 TTY 执行回调，随后恢复原值。
 *
 * TUI 结构化协议只在 TTY 下启用；测试环境 stdin 非 TTY，必须显式伪造，
 * 且 afterEach 式恢复避免污染后续「非 TTY 默认拒绝」用例。
 */
async function withTty(fn) {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
  }
}

/** 构造一个 write 工具调用的 BeforeToolCallContext。 */
function writeContext(target = "a.txt") {
  return {
    assistantMessage: { role: "assistant", content: [], timestamp: 0 },
    toolCall: { type: "toolCall", id: "c-card", name: "write", arguments: { path: target, content: "next" } },
    args: { path: target, content: "next" },
    context: { systemPrompt: "", messages: [], tools: [{ name: "write", effect: "mutate" }] }
  };
}

test("askToolCall：TTY 结构化协议收到摘要与写前 diff，session 映射为会话放行", async () => {
  const seen = [];
  const gate = createToolConfirmGate({
    autoApprove: false,
    cwd: "/tmp/ohna",
    askToolCall: async (info) => {
      seen.push(info);
      return "session";
    }
  });

  const result = await withTty(() => gate(writeContext()));
  assert.equal(result, undefined, "session 应放行本次调用");
  assert.equal(seen.length, 1, "askToolCall 应被调用一次");
  assert.equal(seen[0].tool, "write");
  assert.match(seen[0].summary, /write 写入文件：a\.txt/);
});

test("askToolCall：write/edit 携带 unified diff 预览（写前展示）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ohna-card-"));
  const file = path.join(dir, "a.txt");
  writeFileSync(file, "old\n");

  let info;
  const gate = createToolConfirmGate({
    autoApprove: false,
    cwd: dir,
    askToolCall: async (value) => {
      info = value;
      return "allow";
    }
  });
  const context = writeContext("a.txt");
  context.context = { ...context.context, tools: [{ name: "write", effect: "mutate" }] };
  await withTty(() => gate(context));

  assert.ok(info.diff, "应把 diff 预览交给权限卡");
  assert.match(info.diff, /^-old$/m, "diff 应含删除行");
  assert.match(info.diff, /^\+next$/m, "diff 应含新增行");
});

test("askToolCall：deny 与 null 都按拒绝处理（block）", async () => {
  const context = writeContext();

  const denied = createToolConfirmGate({
    autoApprove: false,
    cwd: "/tmp/ohna",
    askToolCall: async () => "deny"
  });
  const denyResult = await withTty(() => denied(context));
  assert.equal(denyResult?.block, true, "deny 应阻断工具执行");

  const interrupted = createToolConfirmGate({
    autoApprove: false,
    cwd: "/tmp/ohna",
    askToolCall: async () => null
  });
  const interruptedResult = await withTty(() => interrupted(context));
  assert.equal(interruptedResult?.block, true, "null（中断）应阻断工具执行");
});

test("notify：TTY 下 --yes 自动放行日志走注入通道而非 stdout", async () => {
  const chunks = [];
  const notified = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const gate = createToolConfirmGate({
      autoApprove: true,
      cwd: "/tmp/ohna",
      notify: (text) => notified.push(text)
    });
    assert.equal(await gate(writeContext()), undefined);
    assert.equal(chunks.length, 0, "注入 notify 后不得再直写 stdout");
    assert.equal(notified.length, 1);
    assert.match(notified[0], /--yes 自动放行/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("--yes（bypass 预设）直接放行 mutating 工具", async () => {
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const gate = createToolConfirmGate({ autoApprove: true, cwd: "/tmp/ohna" });
    const result = await gate({
      assistantMessage: { role: "assistant", content: [], timestamp: 0 },
      toolCall: { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
      args: { command: "ls" },
      context: {
        systemPrompt: "",
        messages: [],
        tools: [{ name: "bash", effect: "mutate" }]
      }
    });
    assert.equal(result, undefined);
  } finally {
    process.stdout.write = originalWrite;
  }
});
