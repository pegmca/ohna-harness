/**
 * 整屏 TUI 布局与 `/` 命令面板单测。
 *
 * 背景（M6 整屏 TUI 验收缺陷）：早期实现把「屏宽 - 2」同时当作 box 的内容区宽度和
 * editor 的渲染宽度，editor 裁到 innerWidth 后 box 再加 2 内边距 + 2 边框，总宽变成
 * 「屏宽 + 2」，末 2 列（` │` / `╯`）被终端折行走样——输入尚未满屏就错位。
 * 这里用 reviewer 的复现场景锁住「无任何行宽 > 屏宽」的约束，并覆盖 `/` 面板的过滤/高亮/夹紧。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@aiagent/term";
import { configure, resetForTest } from "../dist/ui/theme.js";
import { buildPalette, clampIndex, TuiApp } from "../dist/ui/tui/tui-app.js";
import { filterSlashCommands, listPanelCommands } from "../dist/commands/registry.js";

/**
 * 构造一个带指定输入内容的 TuiApp。
 *
 * 说明：editor 字段在 TS 里是 private，这里是编译后的 JS 运行时，可直接写入以模拟用户输入。
 *
 * @param value 输入框内容。
 * @param cursor 光标位置（缺省行尾）。
 * @returns TuiApp 实例。
 */
function appWithInput(value, cursor = value.length) {
  const tui = new TuiApp();
  tui.editor.value = value;
  tui.editor.cursor = cursor;
  return tui;
}

test("buildFrame：82 列终端 + 200 字符输入，没有任何行溢出（旧实现 84 列）", () => {
  const tui = appWithInput("x".repeat(200));
  tui.append("第一行对话\n第二行对话\n");
  const frame = tui.buildFrame(82, 24);

  for (const [i, line] of frame.entries()) {
    assert.ok(visibleWidth(line) <= 82, `第 ${i} 行宽 ${visibleWidth(line)} > 82：${JSON.stringify(line)}`);
  }
});

test("buildFrame：输入区三行（顶边框 / 输入行 / 下边框）宽度恒等于终端宽", () => {
  // 覆盖多种屏宽与输入长度组合：包含「距满屏还差几列」的临界情形。
  const cases = [
    [82, 76],
    [82, 77],
    [82, 78],
    [82, 200],
    [40, 200],
    [120, 300],
  ];
  for (const [width, inputLength] of cases) {
    const tui = appWithInput("y".repeat(inputLength), 0); // 光标在行首，覆盖「左侧裁切」分支
    const frame = tui.buildFrame(width, 24);
    const inputBox = frame.slice(-3);
    for (const [i, line] of inputBox.entries()) {
      assert.equal(visibleWidth(line), width, `屏宽 ${width} / 输入 ${inputLength} 字符的输入区第 ${i} 行`);
    }
  }
});

test("buildFrame：80 列 + 超长行（长 cwd/会话/中文）无任何行宽 > 80", () => {
  const tui = new TuiApp();
  const longCwd = "/workspace/" + "very-long-segment/".repeat(30);
  const longSession = "sess-" + "x".repeat(120);
  // 模拟无边框欢迎头的长值行，交由 truncateToWidth 兜底裁剪。
  tui.appendLine(`工作目录  ${longCwd}`);
  tui.appendLine(`会话      ${longSession}（--resume ${longSession} 可恢复）`);
  tui.appendLine("中文内容" + "字".repeat(100)); // CJK 每字 2 列，覆盖宽字符截断
  const frame = tui.buildFrame(80, 24);
  for (const [i, line] of frame.entries()) {
    assert.ok(visibleWidth(line) <= 80, `第 ${i} 行宽 ${visibleWidth(line)} > 80`);
  }
});

test("buildFrame：输入 / 时在输入框下方弹出完整命令面板（12 条 + 键位 footer）", () => {
  const tui = appWithInput("/");
  const frame = tui.buildFrame(80, 24);
  // 无对话内容：帧 = 输入框 3 行 + 面板 13 行（12 条命令 + C2 键位 footer）。
  assert.equal(frame.length, 3 + 13, "帧应为输入框 + 12 行命令 + 1 行 footer");
  const panel = frame.slice(-13).join("\n");
  assert.match(panel, /\/help/, "面板应含 /help");
  assert.match(panel, /\/clear/, "面板应含 /clear");
  assert.match(panel, /\/exit/, "面板应含 /exit");
  assert.match(panel, /\/permissions/, "面板应含 /permissions");
  assert.match(panel, /\/status/, "面板应含 /status");
  assert.match(panel, /\/mcp/, "面板应含 /mcp");
  assert.match(panel, /\/export/, "面板应含 /export");
  assert.match(panel, /↑\/↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭/, "footer 应来自 keymap");
  // 面板在输入框下方：输入框下边框（╰）应是面板上方的一行。
  assert.match(frame[frame.length - 14], /╰/, "输入框下边框应位于面板正上方");
});

test("buildFrame：输入 /he 只显示匹配项 /help（含 footer）", () => {
  const tui = appWithInput("/he");
  const frame = tui.buildFrame(80, 24);
  assert.equal(frame.length, 3 + 2, "一个匹配项 + footer，帧应为输入框 + 2 行面板");
  const panel = frame.slice(-2).join("\n");
  assert.match(panel, /\/help/, "应含 /help");
  assert.doesNotMatch(panel, /\/clear/, "不应含 /clear");
  assert.doesNotMatch(panel, /\/exit/, "不应含 /exit");
});

test("buildFrame：终端很矮时面板按可用高度裁剪并提示 overflow", () => {
  const tui = appWithInput("/");
  const frame = tui.buildFrame(80, 8);
  assert.equal(frame.length, 8, "整帧不得超过终端高度");
  const panel = frame.slice(-5).join("\n");
  assert.match(panel, /还有 9 条/, "其余候选应给出 overflow 提示而不是静默丢弃");
  assert.match(panel, /↑\/↓ 选择/, "footer 仍应保留");
});

test("buildFrame：输入含空格后关闭面板（进入参数阶段）", () => {
  const tui = appWithInput("/model ");
  const frame = tui.buildFrame(80, 24);
  assert.equal(frame.length, 3, "面板应关闭，帧仅输入框 3 行");
});

test("buildFrame：setStatus 在帧末尾追加状态行（左权限模式 + 右模型/占比）", () => {
  const tui = new TuiApp();
  const frameWithout = tui.buildFrame(80, 24);
  assert.equal(frameWithout.length, 3, "无状态时帧仅输入框 3 行");

  tui.setStatus(() => ({ model: "hy3-x", contextPercent: 42, permissionMode: "plan" }));
  const frameWith = tui.buildFrame(80, 24);
  assert.equal(frameWith.length, frameWithout.length + 1, "setStatus 后帧末尾应多一行");

  const statusLine = frameWith[frameWith.length - 1];
  assert.ok(visibleWidth(statusLine) <= 80, `状态行可见宽 ${visibleWidth(statusLine)} > 80`);
  assert.match(statusLine, /^⏵⏵ plan\s+hy3-x · 42%$/, "左侧权限模式、右侧模型/占比，单行两端对齐");
});

test("buildFrame：状态行占比越界时夹紧到 [0, 100]", () => {
  const tui = new TuiApp();
  tui.setStatus(() => ({ model: "hy3-x", contextPercent: 250, permissionMode: "default" }));
  let frame = tui.buildFrame(80, 24);
  assert.match(frame[frame.length - 1], /100%$/, ">100 应夹紧到 100%");

  tui.setStatus(() => ({ model: "hy3-x", contextPercent: -3, permissionMode: "default" }));
  frame = tui.buildFrame(80, 24);
  assert.match(frame[frame.length - 1], /0%$/, "<0 应夹紧到 0%");
});

test("filterSlashCommands：按前缀过滤（大小写不敏感、空串返回全部）", () => {
  assert.equal(filterSlashCommands("").length, 12);
  assert.equal(filterSlashCommands("/").length, 12);
  assert.deepEqual(filterSlashCommands("/he").map((c) => c.name), ["/help"]);
  assert.deepEqual(filterSlashCommands("/HE").map((c) => c.name), ["/help"]);
  assert.equal(filterSlashCommands("/help").length, 1);
  assert.equal(filterSlashCommands("foo").length, 0);
});

test("buildPalette：选中行改用 selected 颜色块（不再依赖反转视频），未选中行铺 panel", () => {
  const all = filterSlashCommands("/");
  configure({ forced: true });
  try {
    const palette = buildPalette(all, 0);
    assert.equal(palette.length, 12);
    assert.match(
      palette[0],
      /^\x1b\[48;2;58;42;32;38;2;252;233;212m/,
      "选中行应以 selected 背景 + selectedText 前景开头",
    );
    assert.match(palette[0], /\x1b\[0m$/, "选中行应以全量复位结尾");
    assert.match(palette[1], /^\x1b\[48;2;27;19;16m/, "未选中行应铺 panel 背景");
    assert.doesNotMatch(palette[0], /\x1b\[7m/, "选中态不再使用反转视频");
  } finally {
    resetForTest();
  }
});

test("buildFrame：forced ANSI 下背景 SGR 不改变可见宽（每行仍 <= 屏宽）", () => {
  configure({ forced: true });
  try {
    const tui = appWithInput("/he");
    tui.appendLine("对话一行");
    const frame = tui.buildFrame(40, 24);
    for (const [i, line] of frame.entries()) {
      assert.ok(visibleWidth(line) <= 40, `第 ${i} 行宽 ${visibleWidth(line)} > 40`);
    }
    assert.ok(frame.some((line) => line.includes("\x1b[48;2;27;19;16m")), "panel 背景应铺在面板行");
    for (const line of frame.slice(-2)) {
      assert.ok(!line.includes("\x1b[7m"), "面板行不应依赖反转视频（输入框光标仍可反色）");
    }
  } finally {
    resetForTest();
  }
});

test("clampIndex：选中索引越界时夹紧（过滤结果变化后）", () => {
  assert.equal(clampIndex(0, 8), 0);
  assert.equal(clampIndex(7, 8), 7);
  assert.equal(clampIndex(8, 8), 7, "等于长度应夹到末位");
  assert.equal(clampIndex(99, 8), 7);
  assert.equal(clampIndex(-1, 8), 0);
  assert.equal(clampIndex(5, 0), 0, "空列表返回 0");
});

test("命令注册表：面板命令覆盖 /permissions 且每条都能被 `/` 过滤命中（F-5）", () => {
  // 面板数据源是注册表：任何新增命令只改定义表一处，面板 / 过滤自动可见。
  const panel = listPanelCommands();
  const names = panel.map((c) => c.name);
  assert.ok(names.includes("/permissions"), "B2 的 /permissions 应出现在面板数据源");
  assert.ok(names.includes("/status"), "F-8 的 /status 应出现在面板数据源");
  assert.ok(names.includes("/mcp"), "F-8 的 /mcp 应出现在面板数据源");
  assert.ok(names.includes("/export"), "F-8 的 /export 应出现在面板数据源");
  assert.equal(names.length, 12, "面板应为 9 条旧命令 + 3 条 F-8 新命令（/verbose 隐藏）");
  for (const command of panel) {
    assert.deepEqual(
      filterSlashCommands(command.name).map((c) => c.name),
      [command.name],
      `输入 ${command.name} 应精确命中自身`,
    );
    assert.ok(command.description.length > 0, `${command.name} 应有参数/用途提示`);
  }
});

test("Tab 补全：选中命令写入输入框并追加空格，便于继续输入参数（F-5）", () => {
  const tui = appWithInput("/he");
  // 走完整的输入路由：palette 模式消费 Tab，行为与旧 handlePanelKey 一致。
  tui.handleInput("\t");
  assert.equal(tui.editor.value, "/help ", "补全后应追加空格");
  assert.equal(tui.editor.cursor, "/help ".length, "光标应置于行尾");
});

test("buildFrame：openSessionPicker 在输入框下方展示会话列表，Enter 触发 onSessionSelected", () => {
  const tui = new TuiApp();
  tui.openSessionPicker([
    { id: "abc-123", title: "重构会话", updatedAt: Date.now(), messageCount: 5 },
    { id: "def-456", title: "另一个会话", updatedAt: Date.now(), messageCount: 2 },
  ]);

  const frame = tui.buildFrame(80, 24);
  assert.ok(frame.some((line) => line.includes("重构会话")), "应展示会话标题");
  assert.ok(frame.some((line) => line.includes("选择会话")), "应展示选择器头部");

  let selected;
  tui.onSessionSelected = (id) => {
    selected = id;
  };
  tui.handleInput("\u001b[B");
  tui.handleInput("\r");
  assert.equal(selected, "def-456", "Enter 应回调当前选中会话 id");

  const after = tui.buildFrame(80, 24);
  assert.ok(!after.some((line) => line.includes("选择会话")), "选中后面板应关闭");
});

test("openSessionPicker：Esc 通过路由弹栈关闭面板", async () => {
  const tui = new TuiApp();
  tui.openSessionPicker([
    { id: "abc-123", title: "重构会话", updatedAt: Date.now(), messageCount: 5 },
  ]);
  assert.ok(tui.buildFrame(80, 24).some((line) => line.includes("选择会话")));
  tui.handleInput("\x1b");
  // 单个 ESC 先被 assembler 缓冲以区分「Esc」与「CSI 前缀」，超时兜底后才分发。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    !tui.buildFrame(80, 24).some((line) => line.includes("选择会话")),
    "Esc 应关闭选择器且不被 syncModes 重新压栈",
  );
});

test("输入前置层：跨 chunk 的 CSI（\\x1b + [B）作为一次输入，不被当成 Esc + 字符", () => {
  const tui = new TuiApp();
  tui.openSessionPicker([
    { id: "abc-123", title: "重构会话", updatedAt: Date.now(), messageCount: 5 },
    { id: "def-456", title: "另一个会话", updatedAt: Date.now(), messageCount: 2 },
  ]);

  // 同一 tick 内把 Down 键拆成两次送达：assembler 必须拼回一个完整 `\x1b[B`。
  tui.handleInput("\x1b");
  tui.handleInput("[B");

  assert.ok(
    tui.buildFrame(80, 24).some((line) => line.includes("选择会话")),
    "半截 ESC 不得被当成 Esc 关掉面板",
  );
  assert.equal(tui.editor.value, "", "尾段 `[B` 不得被 editor 当字符插入");

  let selected;
  tui.onSessionSelected = (id) => {
    selected = id;
  };
  tui.handleInput("\r");
  assert.equal(selected, "def-456", "Down 生效后应选中第二项");
});

test("askToolCall：权限卡替换输入区，数字直选结算且不向对话流追加问题行（C3）", async () => {
  const tui = new TuiApp();
  const pending = tui.askToolCall({
    tool: "write",
    summary: "write 写入文件：a.txt",
    diff: "@@ -1 +1 @@\n+hello",
  });

  const frame = tui.buildFrame(80, 24);
  assert.ok(frame.some((line) => line.includes("权限确认")), "卡片应替换输入区");
  assert.ok(frame.some((line) => line.includes("[1] 允许一次")), "应渲染三选项");
  assert.ok(frame.some((line) => line.includes("+hello")), "应渲染 diff 预览");
  assert.ok(!frame.some((line) => line.includes("╭─ ohna")), "卡片激活时输入框让位（不追加问题行）");

  tui.handleInput("2");
  assert.equal(await pending, "session", "数字 2 应直选「本会话一律」");
  assert.ok(
    !tui.buildFrame(80, 24).some((line) => line.includes("权限确认")),
    "结算后卡片关闭、输入区恢复",
  );
});

test("askToolCall：Esc 显式拒绝，Promise 必定 resolve（不挂起、不中断 run）", async () => {
  const tui = new TuiApp();
  let interrupts = 0;
  tui.onInterrupt = () => {
    interrupts += 1;
  };
  const pending = tui.askToolCall({ tool: "bash", summary: "bash 执行命令：ls" });
  tui.handleInput("\x1b");
  assert.equal(await pending, "deny", "Esc 是显式拒绝");
  assert.equal(interrupts, 0, "拒绝权限不应触发全局中断");
});

test("askToolCall：AbortSignal 中断时按 null 结算并关闭卡片", async () => {
  const tui = new TuiApp();
  const controller = new AbortController();
  const pending = tui.askToolCall({ tool: "write", summary: "write 写入文件：a.txt" }, controller.signal);
  assert.ok(tui.buildFrame(80, 24).some((line) => line.includes("权限确认")));
  controller.abort();
  assert.equal(await pending, null, "中断按 null 结算（闸门按拒绝处理）");
  assert.ok(!tui.buildFrame(80, 24).some((line) => line.includes("权限确认")), "中断后卡片关闭");
});

test("toast：输入框上方合成 1 行，排队时以 +N more 展示（C3）", () => {
  const tui = new TuiApp();
  tui.toast("hello");
  assert.ok(tui.buildFrame(80, 24).some((line) => line.includes("hello")), "toast 应显示在帧内");

  // 暂停后新提示入队，当前条保持并显示排队计数。
  tui.state.toasts.pause();
  tui.toast("second");
  const frame = tui.buildFrame(80, 24);
  assert.ok(
    frame.some((line) => line.includes("hello") && line.includes("+1 more")),
    "排队计数应与当前 toast 同屏（1 行合成槽）",
  );
});

test("ctrl+o：toggleLastGroup 原地开关最近一个折叠组，不追加对话行", () => {
  const entries = [
    { id: "tool-0", kind: "tool", status: "done", text: "", meta: { toolName: "read", args: { path: "README.md" }, result: { content: [{ type: "text", text: "a" }] } } },
    { id: "tool-1", kind: "tool", status: "done", text: "", meta: { toolName: "read", args: { path: "AGENTS.md" }, result: { content: [{ type: "text", text: "b" }] } } },
    { id: "tool-2", kind: "tool", status: "done", text: "", meta: { toolName: "bash", args: { command: "ls" }, result: { content: [{ type: "text", text: "ok" }] } } },
  ];
  // 最小条目源：entries + subscribe + appendNotice（与 PrintPresenter 窄接口一致）。
  const listeners = new Set();
  const source = {
    entries: () => entries,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    appendNotice: () => {},
  };
  const tui = new TuiApp();
  tui.attachStream(source);
  tui.setVerbosity("medium");

  const collapsed = tui.buildFrame(80, 24);
  assert.ok(collapsed.some((line) => line.includes("+ 2 reads")), "medium 下 exploration 组默认折叠");

  assert.equal(tui.toggleLastGroup(), true, "应找到最近一个可折叠组");
  const expanded = tui.buildFrame(80, 24);
  assert.ok(expanded.some((line) => line.includes("− 2 reads")), "ctrl+o 组头应变为展开态");
  assert.ok(expanded.some((line) => line.includes("read(README.md)")), "展开后应显示子项");
  assert.ok(expanded.length > collapsed.length, "展开是原地重投影，不是追加对话行");

  assert.equal(tui.toggleLastGroup(), true);
  assert.ok(tui.buildFrame(80, 24).some((line) => line.includes("+ 2 reads")), "再次 ctrl+o 应收起该组");
});

/**
 * 构造一个最小条目源（entries + subscribe + appendNotice + appendUser）。
 *
 * @param entries 初始条目。
 * @returns {{source: object, listeners: Set<Function>, entries: Array}} 源对象与可变条目数组。
 */
function makeEntrySource(entries) {
  const listeners = new Set();
  return {
    source: {
      entries: () => entries,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      appendNotice: () => {},
      appendUser: () => {},
    },
    listeners,
    entries,
  };
}

test("buildFrame：极小终端（3~6 行 + 状态行 + toast）帧长恒 <= height（M1 不变量）", () => {
  for (const height of [3, 4, 5, 6]) {
    const tui = appWithInput("x".repeat(40));
    tui.setStatus(() => ({ model: "m", contextPercent: 1, permissionMode: "default" }));
    tui.toast("hello");
    const frame = tui.buildFrame(40, height);
    assert.ok(frame.length <= height, `height=${height} 帧长 ${frame.length} 应 <= ${height}`);
  }
});

test("buildFrame：极小终端下权限卡也不越界（M1）", async () => {
  const tui = new TuiApp();
  tui.setStatus(() => ({ model: "m", contextPercent: 1, permissionMode: "default" }));
  tui.toast("t");
  const pending = tui.askToolCall({
    tool: "write",
    summary: "write 写入文件：a.txt",
    diff: "@@ -1 +1 @@\n+hello",
  });
  for (const height of [4, 5, 6]) {
    const frame = tui.buildFrame(40, height);
    assert.ok(frame.length <= height, `height=${height} 帧长 ${frame.length} 应 <= ${height}`);
  }
  tui.handleInput("3");
  assert.equal(await pending, "deny");
});

test("appendUser：用户输入回显为 user 语义条目并以 ❯ 呈现（M3）", () => {
  const tui = new TuiApp();
  tui.appendUser("你好世界");
  const frame = tui.buildFrame(80, 24);
  assert.ok(frame.some((line) => line.includes("❯ 你好世界")), "应渲染 user 条目");
  assert.equal(tui.state.entries().at(-1).kind, "user", "条目类别应为 user");
});

test("resetView：清空 expanded、滚动归零并清空 toast（M2）", () => {
  const { source } = makeEntrySource([
    { id: "tool-0", kind: "tool", status: "done", text: "", meta: { toolName: "read", args: { path: "README.md" }, result: { content: [{ type: "text", text: "a" }] } } },
    { id: "tool-1", kind: "tool", status: "done", text: "", meta: { toolName: "read", args: { path: "AGENTS.md" }, result: { content: [{ type: "text", text: "b" }] } } },
  ]);
  const tui = new TuiApp();
  tui.attachStream(source);
  tui.setVerbosity("medium");

  tui.toggleLastGroup();
  assert.ok(tui.state.expanded.size > 0, "前置条件：应有展开状态");
  tui.state.setScroll(10, 60);
  tui.toast("旧会话提示");

  tui.resetView();
  assert.equal(tui.state.expanded.size, 0, "expanded 应清空");
  assert.equal(tui.state.historyOffset, 0, "滚动偏移应归零");
  assert.equal(tui.state.backfill, 0, "回填行数应归零");
  assert.equal(tui.state.toasts.current, undefined, "toast 应清空");
  assert.ok(!tui.buildFrame(80, 24).some((line) => line.includes("旧会话提示")), "旧 toast 不应再出现在帧内");
});

test("权限卡激活期间暂停 toast 计时，结算后恢复（M5）", async () => {
  const tui = new TuiApp();
  tui.toast("提示", { duration: 30 });
  const pending = tui.askToolCall({ tool: "bash", summary: "bash 执行命令：ls" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(
    tui.buildFrame(80, 24).some((line) => line.includes("提示")),
    "卡片激活期间 toast 不应超时消失",
  );
  tui.handleInput("1");
  assert.equal(await pending, "allow");
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.ok(
    !tui.buildFrame(80, 24).some((line) => line.includes("提示")),
    "结算恢复后 toast 应按时消失",
  );
});
