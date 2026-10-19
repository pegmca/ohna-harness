/**
 * CLI 参数解析单测：--key=value、缺失取值、非法数字与位置参数。
 *
 * 通过注入 warn 收集器验证「只告警、不崩溃，也不吞掉下一个 flag」的约定。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../dist/cli/args.js";

/**
 * 运行一次解析并收集告警。
 *
 * @param argv 参数列表。
 * @returns {{options: any, warnings: string[]}}
 */
function parse(argv) {
  const warnings = [];
  const options = parseArgs(argv, (message) => warnings.push(message));
  return { options, warnings };
}

test("--key=value 与 --key value 等价解析", () => {
  const inline = parse(["--model=deepseek", "--max-turns=3", "--max-cost=0.01", "--resume=abc"]);
  assert.equal(inline.options.model, "deepseek");
  assert.equal(inline.options.maxTurns, 3);
  assert.equal(inline.options.maxCost, 0.01);
  assert.equal(inline.options.resume, "abc");
  assert.deepEqual(inline.warnings, []);

  const spaced = parse(["--model", "deepseek", "--max-turns", "3", "--max-cost", "0.01"]);
  assert.equal(spaced.options.model, "deepseek");
  assert.equal(spaced.options.maxTurns, 3);
  assert.equal(spaced.options.maxCost, 0.01);
  assert.deepEqual(spaced.warnings, []);
});

test("取值选项后紧跟 --flag 时视为缺失，不吞掉下一个 flag（P3-9）", () => {
  const { options, warnings } = parse(["--max-turns", "--yes", "做一个任务"]);
  assert.equal(options.maxTurns, undefined);
  assert.equal(options.yes, true);
  assert.equal(options.prompt, "做一个任务");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /--max-turns 缺少取值/);
});

test("取值选项位于末尾或内联值为空时告警并忽略", () => {
  const atEnd = parse(["--max-cost"]);
  assert.equal(atEnd.options.maxCost, undefined);
  assert.match(atEnd.warnings[0], /--max-cost 缺少取值/);

  const emptyInline = parse(["--model=", "--help"]);
  assert.equal(emptyInline.options.model, undefined);
  assert.equal(emptyInline.options.help, true);
  assert.match(emptyInline.warnings[0], /--model 缺少取值/);
});

test("非法数字告警后忽略，不影响其它参数（P3-9）", () => {
  const { options, warnings } = parse([
    "--max-turns",
    "abc",
    "--deadline-ms",
    "-5",
    "--max-cost",
    "-1",
    "--model",
    "deepseek",
  ]);
  assert.equal(options.maxTurns, undefined);
  assert.equal(options.deadlineMs, undefined);
  assert.equal(options.maxCost, undefined);
  assert.equal(options.model, "deepseek", "非法数字只影响自己，不波及其它参数");
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /--max-turns 需要正整数/);
  assert.match(warnings[1], /--deadline-ms 需要正整数/);
  assert.match(warnings[2], /--max-cost 需要非负数/);
});

test("取值选项后紧跟短开关时也视为缺失，不吞掉 -h / -y（D6）", () => {
  const help = parse(["--max-turns", "-h"]);
  assert.equal(help.options.maxTurns, undefined);
  assert.equal(help.options.help, true, "-h 必须仍然生效并显示 help");
  assert.match(help.warnings[0], /--max-turns 缺少取值/);

  const yes = parse(["--model", "-y", "做一个任务"]);
  assert.equal(yes.options.model, undefined);
  assert.equal(yes.options.yes, true);
  assert.equal(yes.options.prompt, "做一个任务");
  assert.match(yes.warnings[0], /--model 缺少取值/);
});

test("负数字面量仍走数字校验，不被当作开关（D6 边界）", () => {
  const { options, warnings } = parse(["--max-cost", "-1"]);
  assert.equal(options.maxCost, undefined);
  assert.match(warnings[0], /--max-cost 需要非负数/);
});

test("--max-cost 0 是合法零预算；位置参数合并为 prompt", () => {
  const { options, warnings } = parse(["--max-cost", "0", "hello", "world"]);
  assert.equal(options.maxCost, 0);
  assert.equal(options.prompt, "hello world");
  assert.deepEqual(warnings, []);
});

test("--no-team 关闭团队编排；缺省保持开启（F-4）", () => {
  const enabled = parse([]);
  assert.equal(enabled.options.team, true, "团队编排默认开启");

  const disabled = parse(["--no-team", "做一个任务"]);
  assert.equal(disabled.options.team, false);
  assert.equal(disabled.options.prompt, "做一个任务", "--no-team 是开关，不吞位置参数");
  assert.deepEqual(disabled.warnings, []);
});
