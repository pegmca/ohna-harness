/**
 * 主题层单测：ANSI 能力探测矩阵、configure/resetForTest 覆盖与复位、paint 降级。
 *
 * node:test 跑在管道（非 TTY），因此默认 `supportsAnsi()` 为 false；探测矩阵里
 * 通过临时 mock `process.stdout.isTTY` 验证「TTY + NO_COLOR + TERM=dumb」三条件门控。
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  BACKGROUND,
  configure,
  inputBottomBar,
  inputTopBar,
  paint,
  paintBg,
  paintOnSurface,
  resetForTest,
  surface,
  supportsAnsi,
} from "../dist/ui/theme.js";

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

test("paint：C5 新增 selected / selectedText / focused 角色可解析", () => {
  configure({ forced: true });
  assert.equal(paint("x", "selected"), "\x1b[38;2;58;42;32mx\x1b[0m");
  assert.equal(paint("x", "selectedText"), "\x1b[38;2;252;233;212mx\x1b[0m");
  assert.equal(paint("x", "focused"), "\x1b[38;2;255;159;69mx\x1b[0m");
});

test("paintBg：选中行背景 + 前景一次成对输出，非 TTY 原样降级", () => {
  assert.equal(paintBg("row", "selected", "selectedText"), "row", "非 TTY 不得产生 ANSI");

  configure({ forced: true });
  assert.equal(
    paintBg("row", "selected", "selectedText"),
    "\x1b[48;2;58;42;32;38;2;252;233;212mrow\x1b[0m",
    "选中行应为 selected 背景 + selectedText 前景",
  );
  assert.equal(
    paintBg("row", "selected"),
    "\x1b[48;2;58;42;32;38;2;232;220;203mrow\x1b[0m",
    "前景缺省为 foreground",
  );
});

test("surface：四个 BACKGROUND 表面按 24-bit 背景解析，且非 TTY 为空串", () => {
  for (const name of Object.keys(BACKGROUND)) {
    assert.equal(surface(name), "", `非 TTY 下 surface(${name}) 应为空串`);
  }

  configure({ forced: true });
  assert.equal(surface("canvas"), "\x1b[48;2;24;15;13m");
  assert.equal(surface("panel"), "\x1b[48;2;27;19;16m");
  assert.equal(surface("toolCard"), "\x1b[48;2;36;26;20m");
  assert.equal(surface("stroke"), "\x1b[48;2;56;41;31m");
});

test("surface：TTY + NO_COLOR 下仍为空串（NO_COLOR 优先）", () => {
  withTty(true, () => {
    withEnv({ NO_COLOR: "1", TERM: "xterm-256color" }, () => {
      for (const name of Object.keys(BACKGROUND)) assert.equal(surface(name), "");
      assert.equal(paintOnSurface("x", "panel"), "x");
      assert.equal(paintBg("x", "selected", "selectedText"), "x");
    });
  });
});

test("paintOnSurface：背景复位可靠，内部 paint 复位后重放背景", () => {
  configure({ forced: true });
  const dim = paint("b", "dim");
  const wrapped = paintOnSurface(`a${dim}c`, "panel");
  const bg = "\x1b[48;2;27;19;16m";
  assert.ok(wrapped.startsWith(bg), "整行以 panel 背景开头");
  assert.ok(wrapped.endsWith("\x1b[49m"), "结尾只复位背景，避免误伤前景样式");
  assert.equal(wrapped.split(bg).length - 1, 2, "内部 paint 复位后应重放一次背景");
  assert.ok(!wrapped.endsWith("\x1b[0m"), "不应以全量复位收尾");
});

test("paintOnSurface：非 TTY 逐字节原样返回（BACKGROUND 消费路径零 ANSI 泄漏）", () => {
  const text = "plain row";
  for (const name of Object.keys(BACKGROUND)) {
    assert.equal(paintOnSurface(text, name), text, `surface(${name}) 不得泄漏 ANSI`);
  }
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
