/**
 * 欢迎头单测：TTY / 非 TTY 双路径。
 *
 * 非 TTY：纯文本头（无 `\x1b`、无 logo）；TTY（configure forced=true）：块状 OHNA logo + 信息行。
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

test("renderWelcome：TTY（forced）输出块状 logo + 信息行（无边框）", () => {
  configure({ forced: true });
  const out = captureStdout(() =>
    renderWelcome(model, toolNames, { cwd: "/tmp/ws", sessionId: "abc123" }),
  );
  assert.match(out, /█/, "应含块状 OHNA logo");
  assert.doesNotMatch(out, /Welcome to ohna!/, "不应再含 Welcome 欢迎语");
  assert.doesNotMatch(out, /✻/, "不应再含 ✻ 标记");
  assert.doesNotMatch(out, /╭/, "无边框：不应再画框面板");
  assert.doesNotMatch(out, /╰/, "无边框：不应再画框面板");
  assert.match(out, /工作目录/, "应含工作目录行");
  assert.match(out, /\/tmp\/ws/, "应含工作目录路径");
  assert.match(out, /abc123/, "应含会话 id");
});

test("renderWelcome：TTY 输出含 ANSI 颜色（forced）", () => {
  configure({ forced: true });
  const out = captureStdout(() => renderWelcome(model, toolNames, {}));
  assert.equal(out.includes("\x1b[38;2;"), true, "TTY 下应含 24-bit truecolor");
});

test("CLI_LOGO：5 行等宽，拼出大写 OHNA 块状字母", () => {
  assert.equal(CLI_LOGO.length, 5, "应为 5 行");
  const joined = CLI_LOGO.join("\n");
  assert.match(joined, /█/, "应含块状像素（U+2588）");
  assert.equal(joined.includes("\x1b"), false, "logo 源文本不应含 ANSI（着色在渲染时 paint）");
  assert.ok(CLI_LOGO.every((line) => line.includes("█")), "每行都应含块状像素");
  // 每行长度一致（4 字母 × 7 列 + 3 空隙 = 31 列），整体左右对称居中。
  const widths = new Set(CLI_LOGO.map((line) => line.length));
  assert.equal(widths.size, 1, "每行长度应一致");
  assert.equal(CLI_LOGO[0].length, 31, "应为 31 列（4×7 + 3 空隙）");
  // 4 个字母块（O/H/N/A，各 7 列、间隙 1 列）在每行都非空，确保拼出完整 OHNA。
  for (let letter = 0; letter < 4; letter++) {
    const start = letter * 8;
    for (const line of CLI_LOGO) {
      assert.ok(
        line.slice(start, start + 7).includes("█"),
        `第 ${letter + 1} 个字母块每行都应含块状像素`,
      );
    }
  }
});

test("renderWelcome：TTY（forced）输出含块状 logo 与配色", () => {
  configure({ forced: true });
  const out = captureStdout(() =>
    renderWelcome(model, toolNames, { cwd: "/tmp/ws" }),
  );
  assert.match(out, /█/, "TTY 应含块状 logo");
  assert.equal(out.includes("\x1b"), true, "TTY 下 logo 应被着色（含 ANSI）");
});

test("renderWelcome：非 TTY 不含 logo（纯文本管道）", () => {
  const out = captureStdout(() =>
    renderWelcome(model, toolNames, { cwd: "/tmp/ws" }),
  );
  assert.doesNotMatch(out, /█/, "非 TTY 不应含 logo");
  assert.equal(out.includes("\x1b"), false, "非 TTY 不应含 ANSI");
});
