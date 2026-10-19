/**
 * slash 命令解析与分发单测：别名、参数切分、分发回调与未知命令提示。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSlashDispatcher, parseSlashCommand } from "../dist/commands/slash.js";

test("parseSlashCommand：命令名与参数切分", () => {
  assert.deepEqual(parseSlashCommand("/model deepseek"), { name: "model", arg: "deepseek" });
  assert.deepEqual(parseSlashCommand("/resume"), { name: "resume", arg: "" });
  assert.deepEqual(parseSlashCommand("  /COST  "), { name: "cost", arg: "" });
  assert.deepEqual(parseSlashCommand("/tools"), { name: "tools", arg: "" });
  assert.deepEqual(parseSlashCommand("/compact"), { name: "compact", arg: "" });
  assert.deepEqual(parseSlashCommand("/model"), { name: "model", arg: "" });
  // 普通提问与未知命令返回 null（交由模型处理）。
  assert.equal(parseSlashCommand("帮我看看这个文件"), null);
  assert.equal(parseSlashCommand("/nope"), null);
  assert.equal(parseSlashCommand(""), null);
});

test("parseSlashCommand：旧别名保持兼容（/?、/reset、:q、exit）", () => {
  assert.equal(parseSlashCommand("/?")?.name, "help");
  assert.equal(parseSlashCommand("/reset")?.name, "clear");
  assert.equal(parseSlashCommand(":q")?.name, "exit");
  assert.equal(parseSlashCommand("quit")?.name, "exit");
});

test("createSlashDispatcher：命中回调且不进入模型调用", async () => {
  const calls = [];
  const dispatch = createSlashDispatcher({
    handlers: {
      tools: () => calls.push("tools"),
      cost: () => calls.push("cost"),
      model: (arg) => calls.push(`model:${arg}`),
      resume: (arg) => calls.push(`resume:${arg}`),
      compact: () => calls.push("compact"),
    },
  });
  assert.equal(await dispatch("/tools"), true);
  assert.equal(await dispatch("/cost"), true);
  assert.equal(await dispatch("/model deepseek"), true);
  assert.equal(await dispatch("/resume"), true);
  assert.equal(await dispatch("/compact"), true);
  assert.equal(await dispatch("普通问题"), false, "普通输入必须返回 false 交给模型");
  assert.deepEqual(calls, ["tools", "cost", "model:deepseek", "resume:", "compact"]);
});

test("createSlashDispatcher：已注册但未提供 handler 的命令走 onUnknown", async () => {
  const unknown = [];
  const dispatch = createSlashDispatcher({
    handlers: {},
    onUnknown: (name) => unknown.push(name),
  });
  assert.equal(await dispatch("/exit"), true);
  assert.deepEqual(unknown, ["exit"]);
});
