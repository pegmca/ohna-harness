/**
 * 欢迎头单测：TTY / 非 TTY 双路径。
 *
 * 非 TTY：纯文本头（无 `\x1b`、无 `✻`）；TTY（configure forced=true）：`✻` 标题 + 边框面板。
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configure, resetForTest } from "../dist/theme.js";
import { CLI_LOGO, renderWelcome } from "../dist/welcome.js";

/** 每个用例后复位 forced 覆盖。 */
afterEach(() => resetForTest());

/** 捕获 stdout 的工具函数。 */
function captureStdout(run) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

const model = { id: "deepseek-chat", provider: "deepseek", baseUrl: "https://api.example.com/v1" };
const toolNames = ["read", "write", "bash"];

test("renderWelcome：非 TTY 输出纯文本头，不含 ANSI 与 ✻", () => {
  const out = captureStdout(() =>
    renderWelcome(model, toolNames, { cwd: "/tmp/ws" }),
  );
  assert.equal(out.includes("\x1b"), false, "非 TTY 不应含 ANSI 转义");
  assert.doesNotMatch(out, /✻/, "非 TTY 不应含 ✻");
  assert.doesNotMatch(out, /╭/, "非 TTY 不应含边框");
  assert.match(out, /  ohna\n/, "应含统一标题 ohna");
  assert.match(out, /deepseek-chat/, "应含模型 id");
  assert.match(out, /read · write · bash/, "应含工具清单");
});

test("renderWelcome：TTY（forced）输出 ✻ 标题 + 边框面板", () => {
  configure({ forced: true });
  const out = captureStdout(() =>
    renderWelcome(model, toolNames, { cwd: "/tmp/ws", sessionId: "abc123" }),
  );
  assert.match(out, /✻/, "应含 ✻ 标记");
  assert.match(out, /Welcome to ohna!/, "应含欢迎语");
  assert.match(out, /╭/, "应含边框上缘");
  assert.match(out, /╰/, "应含边框下缘");
  assert.match(out, /工作目录/, "应含工作目录行");
  assert.match(out, /\/tmp\/ws/, "应含工作目录路径");
  assert.match(out, /abc123/, "应含会话 id");
});

test("renderWelcome：TTY 输出含 ANSI 颜色（forced）", () => {
  configure({ forced: true });
  const out = captureStdout(() => renderWelcome(model, toolNames, {}));
  assert.equal(out.includes("\x1b[38;2;"), true, "TTY 下应含 24-bit truecolor");
});

test("CLI_LOGO：长度 4 的数组，含双环 ∞ ASCII 装饰", () => {
  assert.equal(CLI_LOGO.length, 4, "应为 4 行");
  const joined = CLI_LOGO.join("\n");
  assert.match(joined, /____/, "应含双环顶部横线");
  assert.match(joined, /\\/, "应含交叉反斜杠");
  assert.match(joined, /_/, "应含环底划线");
});

test("renderWelcome：TTY（forced）输出含 logo 特征子串与配色", () => {
  configure({ forced: true });
  const out = captureStdout(() =>
    renderWelcome(model, toolNames, { cwd: "/tmp/ws" }),
  );
  assert.match(out, /____/, "TTY 应含 logo 顶部横线");
  assert.equal(out.includes("\x1b"), true, "TTY 下 logo 应被着色（含 ANSI）");
});

test("renderWelcome：非 TTY 不含 logo（纯文本管道）", () => {
  const out = captureStdout(() =>
    renderWelcome(model, toolNames, { cwd: "/tmp/ws" }),
  );
  assert.doesNotMatch(out, /____/, "非 TTY 不应含 logo");
  assert.equal(out.includes("\x1b"), false, "非 TTY 不应含 ANSI");
});
