/**
 * 主题层单测：ANSI 能力探测矩阵、configure/resetForTest 覆盖与复位、paint 降级。
 *
 * node:test 跑在管道（非 TTY），因此默认 `supportsAnsi()` 为 false；探测矩阵里
 * 通过临时 mock `process.stdout.isTTY` 验证「TTY + NO_COLOR + TERM=dumb」三条件门控。
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configure, inputBottomBar, inputTopBar, paint, resetForTest, supportsAnsi } from "../dist/ui/theme.js";

/** 每个用例后复位 forced 覆盖，避免注入状态跨用例泄漏（§3.6）。 */
afterEach(() => resetForTest());

/**
 * 临时 mock process.stdout.isTTY，跑完后恢复原值。
 *
 * @param {boolean} value 临时 isTTY 值。
 * @param {() => void} fn 在 mock 生效期间执行的断言。
 */
function withTty(value, fn) {
  const stdout = process.stdout;
  const prev = Object.getOwnPropertyDescriptor(stdout, "isTTY");
  Object.defineProperty(stdout, "isTTY", { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (prev) Object.defineProperty(stdout, "isTTY", prev);
    else delete stdout.isTTY;
  }
}

/**
 * 临时替换环境变量，跑完后恢复原值。
 *
 * @param {Record<string, string | undefined>} overrides 键 → 临时值（undefined 表示删除）。
 * @param {() => void} fn 断言。
 */
function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("supportsAnsi：非 TTY 环境默认 false", () => {
  assert.equal(supportsAnsi(), false);
});

test("supportsAnsi：configure forced=true 覆盖为 true，resetForTest 复位", () => {
  configure({ forced: true });
  assert.equal(supportsAnsi(), true, "forced=true 应强制支持 ANSI");
  resetForTest();
  assert.equal(supportsAnsi(), false, "resetForTest 后回到惰性探测");
});

test("supportsAnsi：configure forced=false 覆盖为 false", () => {
  configure({ forced: true });
  configure({ forced: false });
  assert.equal(supportsAnsi(), false, "forced=false 应强制禁用");
});

test("supportsAnsi：探测矩阵（TTY + NO_COLOR + TERM=dumb）", () => {
  withTty(true, () => {
    withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, () => {
      assert.equal(supportsAnsi(), true, "TTY + 无 NO_COLOR + 非 dumb 应支持");
    });
    withEnv({ NO_COLOR: "1", TERM: "xterm-256color" }, () => {
      assert.equal(supportsAnsi(), false, "NO_COLOR=1 应禁用");
    });
    withEnv({ NO_COLOR: undefined, TERM: "dumb" }, () => {
      assert.equal(supportsAnsi(), false, "TERM=dumb 应禁用");
    });
  });
  withTty(false, () => {
    withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" }, () => {
      assert.equal(supportsAnsi(), false, "非 TTY 应禁用");
    });
  });
});

test("paint：非 TTY 降级返回原串，不含 \\x1b", () => {
  assert.equal(paint("hello", "accent"), "hello");
  assert.equal(paint("hello", "error", "bold"), "hello");
  assert.equal(paint("hello", "dim", "italic"), "hello");
});

test("paint：forced=true 输出 24-bit truecolor + 样式修饰", () => {
  configure({ forced: true });
  assert.equal(paint("x", "accent"), "\x1b[38;2;232;98;60mx\x1b[0m");
  assert.equal(paint("x", "error", "bold"), "\x1b[38;2;226;85;61;1mx\x1b[0m");
  assert.equal(paint("x", "dim", "italic"), "\x1b[38;2;140;122;104;3mx\x1b[0m");
});

test("inputBottomBar：非 TTY 返回纯字符串（无 \\x1b），外宽对齐 max(columns,16)", () => {
  const bar = inputBottomBar(20);
  assert.ok(bar.startsWith("╰"), "应以 ╰ 开头");
  assert.ok(bar.endsWith("╯\n"), "应以 ╯\\n 结尾");
  assert.equal(bar.length, 21, "列数 20 → 外宽 20 = 1 + 18 + 1 + 1(换行)");
  assert.equal(bar.includes("\x1b"), false, "本身不带 ANSI（着色在调用点 paint）");
});

test("inputBottomBar：列数 < 16 时按 16 计算外宽", () => {
  const bar = inputBottomBar(5);
  assert.equal(bar.length, 17, "列数 5 → 外宽 16 = 1 + 14 + 1 + 1(换行)");
});

test("inputBottomBar 与 inputTopBar 外宽一致（同列数）", () => {
  for (const cols of [10, 16, 80, 200]) {
    assert.equal(inputBottomBar(cols).length, inputTopBar(cols).length, `列数 ${cols} 外宽应一致`);
  }
});
