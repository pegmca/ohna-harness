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
import { buildPalette, clampIndex, TuiApp } from "../dist/tui-app.js";
import { filterSlashCommands, SLASH_COMMANDS } from "../dist/slash.js";

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

test("buildFrame：输入 / 时在输入框下方弹出完整命令面板（12 条）", () => {
  const tui = appWithInput("/");
  const frame = tui.buildFrame(80, 24);
  // 无对话内容：帧 = 输入框 3 行 + 面板 12 行（F-8 后命令全部可见）。
  assert.equal(frame.length, 3 + 12, "帧应为输入框 + 12 行面板");
  const panel = frame.slice(-12).join("\n");
  assert.match(panel, /\/help/, "面板应含 /help");
  assert.match(panel, /\/clear/, "面板应含 /clear");
  assert.match(panel, /\/exit/, "面板应含 /exit");
  assert.match(panel, /\/permissions/, "面板应含 /permissions");
  assert.match(panel, /\/status/, "面板应含 /status");
  assert.match(panel, /\/mcp/, "面板应含 /mcp");
  assert.match(panel, /\/export/, "面板应含 /export");
  // 面板在输入框下方：输入框下边框（╰）应是面板上方的一行。
  assert.match(frame[frame.length - 13], /╰/, "输入框下边框应位于面板正上方");
});

test("buildFrame：输入 /he 只显示匹配项 /help", () => {
  const tui = appWithInput("/he");
  const frame = tui.buildFrame(80, 24);
  assert.equal(frame.length, 3 + 1, "仅一个匹配项，帧应为输入框 + 1 行面板");
  const panel = frame.slice(-1).join("\n");
  assert.match(panel, /\/help/, "应含 /help");
  assert.doesNotMatch(panel, /\/clear/, "不应含 /clear");
  assert.doesNotMatch(panel, /\/exit/, "不应含 /exit");
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

test("buildPalette：最多 12 行，选中行整行反色高亮", () => {
  const all = filterSlashCommands("/");
  const palette = buildPalette(all, 0);
  assert.equal(palette.length, 12);
  /* eslint-disable no-control-regex -- 反色高亮断言必须匹配 ESC 控制字符 */
  assert.match(palette[0], /^\x1b\[7m/, "选中行应以反色开头");
  assert.match(palette[0], /\x1b\[27m$/, "选中行应以反色复位结尾");
  assert.doesNotMatch(palette[1], /\x1b\[7m/, "未选中行不应高亮");
  /* eslint-enable no-control-regex */
});

test("clampIndex：选中索引越界时夹紧（过滤结果变化后）", () => {
  assert.equal(clampIndex(0, 8), 0);
  assert.equal(clampIndex(7, 8), 7);
  assert.equal(clampIndex(8, 8), 7, "等于长度应夹到末位");
  assert.equal(clampIndex(99, 8), 7);
  assert.equal(clampIndex(-1, 8), 0);
  assert.equal(clampIndex(5, 0), 0, "空列表返回 0");
});

test("SLASH_COMMANDS：面板命令表覆盖 /permissions 且每条都能被 `/` 过滤命中（F-5）", () => {
  // 面板数据源是 SLASH_COMMANDS：任何新增命令必须进表，否则 `/` 面板不可见。
  const names = SLASH_COMMANDS.map((c) => c.name);
  assert.ok(names.includes("/permissions"), "B2 的 /permissions 应出现在面板数据源");
  assert.ok(names.includes("/status"), "F-8 的 /status 应出现在面板数据源");
  assert.ok(names.includes("/mcp"), "F-8 的 /mcp 应出现在面板数据源");
  assert.ok(names.includes("/export"), "F-8 的 /export 应出现在面板数据源");
  assert.equal(names.length, 12, "命令表应为 9 条旧命令 + 3 条 F-8 新命令");
  for (const command of SLASH_COMMANDS) {
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
  // handlePanelKey 为 TS private，但运行时可直接调用（与 appWithInput 同样的测试手法）。
  const consumed = tui.handlePanelKey("\t");
  assert.equal(consumed, true, "Tab 应由面板消费");
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
