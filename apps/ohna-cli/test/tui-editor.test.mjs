/**
 * C1b `LineEditor` 单测：键位矩阵 + CSI 跨 chunk 截断缓冲修复。
 *
 * 背景：raw mode 下一次 stdin chunk 可能恰好落在转义序列中间（如 `\x1b[` 与 `A` 分两次到达）。
 * 改造前残缺序列被直接丢弃，方向键 / Home / bracketed paste 会偶发失效；现在残余会缓冲到
 * 下一 chunk 拼接后再解析，本文件用跨 chunk 用例锁住该行为。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@aiagent/term";
import { LineEditor } from "../dist/ui/tui/tui-editor.js";

/** 构造编辑器（默认提示符，便于断言）。 */
function editor(options = {}) {
  return new LineEditor(options);
}

test("可打印字符插入 / 退格 / 左右光标移动", () => {
  const ed = editor();
  ed.handleInput("abc");
  assert.equal(ed.value, "abc");
  assert.equal(ed.cursor, 3);

  ed.handleInput("\x1b[D");
  assert.equal(ed.cursor, 2, "左方向键光标左移");
  ed.handleInput("X");
  assert.equal(ed.value, "abXc", "在光标处插入");

  ed.handleInput("\x7f");
  assert.equal(ed.value, "abc", "DEL 退格删除光标左侧字符");
  ed.handleInput("\x08");
  assert.equal(ed.value, "ac", "BS 退格同样生效");

  ed.handleInput("\x1b[D");
  ed.handleInput("\x1b[D");
  ed.handleInput("\x1b[D");
  assert.equal(ed.cursor, 0, "光标不得越过行首");
  ed.handleInput("\x1b[C");
  assert.equal(ed.cursor, 1);
});

test("Home / End（含 `1~` / `4~` 变体）移动光标", () => {
  const ed = editor();
  ed.handleInput("hello");
  ed.handleInput("\x1b[H");
  assert.equal(ed.cursor, 0, "Home 到行首");
  ed.handleInput("\x1b[F");
  assert.equal(ed.cursor, 5, "End 到行尾");
  ed.handleInput("\x1b[1~");
  assert.equal(ed.cursor, 0, "`1~` 变体 Home");
  ed.handleInput("\x1b[4~");
  assert.equal(ed.cursor, 5, "`4~` 变体 End");
});

test("上下方向键浏览历史并回退草稿", () => {
  const ed = editor({ history: ["one", "two"] });
  ed.handleInput("dr"); // 进入历史前的草稿
  ed.handleInput("\x1b[A");
  assert.equal(ed.value, "two", "上翻取最近一条");
  ed.handleInput("\x1b[A");
  assert.equal(ed.value, "one", "继续上翻到更旧一条");
  ed.handleInput("\x1b[B");
  assert.equal(ed.value, "two", "下翻回退");
  ed.handleInput("\x1b[B");
  assert.equal(ed.value, "dr", "越过最新项回退到草稿");
});

test("Enter 提交：非空入历史、清空 value、触发 onSubmit 与 onChange", () => {
  const ed = editor();
  const submitted = [];
  let changes = 0;
  ed.onSubmit = (value) => submitted.push(value);
  ed.onChange = () => {
    changes += 1;
  };
  ed.handleInput("hello");
  ed.handleInput("\r");
  assert.deepEqual(submitted, ["hello"]);
  assert.equal(ed.value, "");
  assert.equal(ed.cursor, 0);
  assert.deepEqual(ed.history, ["hello"], "非空提交入历史");
  assert.ok(changes >= 2, "插入与提交都应触发 onChange");
});

test("bracketed paste：跨多字符块一次插入，换行/制表扁平化为空格", () => {
  const ed = editor();
  ed.handleInput("a\x1b[200~b\nc\td\x1b[201~e");
  assert.equal(ed.value, "ab c de", "粘贴内容扁平化后插入");
});

test("全局键不再由 editor 消费（C2：Ctrl+C / Ctrl+O / Shift+Tab 交给 InputRouter）", () => {
  const ed = editor();
  let changes = 0;
  ed.onChange = () => {
    changes += 1;
  };
  ed.handleInput("\x03");
  ed.handleInput("\x0f");
  ed.handleInput("\x1b[Z");
  assert.equal(ed.value, "", "全局键不得插入文本");
  assert.equal(changes, 0, "全局键不得触发 editor 变更回调");
  // 历史 ↑↓ 仍归 editor（router 只裁决全局键）。
  ed.history = ["one"];
  ed.handleInput("\x1b[A");
  assert.equal(ed.value, "one", "方向键历史仍由 editor 处理");
});

test("render：光标反色高亮，超长输入从左裁切且不超宽", () => {
  const ed = editor({ prompt: "> " });
  ed.handleInput("y".repeat(50));
  // 光标在行尾：左侧内容依次裁掉，保证光标始终可见（MVP 不做水平滚动）。
  const line = ed.render(10);
  assert.ok(visibleWidth(line) <= 10, `渲染行可见宽 ${visibleWidth(line)} > 10`);
  assert.match(line, /\x1b\[7m/, "光标字符应以反色标记");
  assert.match(line, /\x1b\[27m/, "反色应复位");
  assert.equal(ed.cursor, 50, "裁切不得改变光标逻辑位置");
});

test("CSI 跨 chunk 截断缓冲：`\\x1b[` + `A` 拼装为 Up", () => {
  const ed = editor({ history: ["one", "two"] });
  ed.handleInput("\x1b[");
  assert.equal(ed.value, "", "不完整序列不应产生任何输入");
  ed.handleInput("A");
  assert.equal(ed.value, "two", "跨 chunk 拼装后应识别为 Up 并取历史");
});

test("CSI 跨 chunk 截断缓冲：`\\x1b[1` + `~` 拼装为 Home", () => {
  const ed = editor();
  ed.handleInput("hello");
  ed.handleInput("\x1b[1");
  ed.handleInput("~");
  assert.equal(ed.cursor, 0, "跨 chunk 的 `1~` 应识别为 Home");
});

test("bracketed paste 起始标记跨 chunk：`\\x1b[20` + `0~…`", () => {
  const ed = editor();
  ed.handleInput("\x1b[20");
  ed.handleInput("0~hello\x1b[201~");
  assert.equal(ed.value, "hello", "跨 chunk 的粘贴标记应被正确识别");
});

test("bracketed paste 结束标记跨 chunk：缓冲内容到下一 chunk", () => {
  const ed = editor();
  ed.handleInput("\x1b[200~wor");
  ed.handleInput("ld\x1b[201~");
  assert.equal(ed.value, "world");
});
