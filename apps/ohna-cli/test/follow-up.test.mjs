/**
 * K2 排队协议单测：slash 命令绝不被 follow-up 注入模型；abort 闸门把队列留给串行兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFollowUpController,
  partitionQueuedLines,
} from "../dist/input/follow-up.js";

test("partitionQueuedLines：普通文本与 slash 命令分区且各自保持顺序", () => {
  const { followUps, commands } = partitionQueuedLines([
    "先看 README",
    "/cost",
    "再改测试",
    "/exit",
  ]);
  assert.deepEqual(followUps, ["先看 README", "再改测试"]);
  assert.deepEqual(commands, ["/cost", "/exit"]);
});

test("partitionQueuedLines：`!` / `#` 直通命令留队，不进入模型上下文", () => {
  const { followUps, commands } = partitionQueuedLines(["!git status", "# 记住用 pnpm", "继续"]);
  assert.deepEqual(followUps, ["继续"]);
  assert.deepEqual(commands, ["!git status", "# 记住用 pnpm"]);
});

test("follow-up：只返回普通文本，命令留在队列里交给 shift 串行分发", async () => {
  const queue = createFollowUpController();
  queue.enqueue("修复按钮");
  queue.enqueue("/cost");
  queue.enqueue("补测试");

  const messages = await queue.getFollowUpMessages();
  assert.deepEqual(messages.map((message) => message.content), ["修复按钮", "补测试"]);
  assert.ok(messages.every((message) => message.role === "user"));
  assert.equal(queue.hasPending(), true, "命令必须留在队列");

  assert.equal(queue.shift(), "/cost");
  assert.equal(queue.hasPending(), false);
  assert.equal(queue.shift(), undefined);
});

test("follow-up：disable（abort 闸门）时返回空且队列保留，reset 后恢复", async () => {
  const queue = createFollowUpController();
  queue.enqueue("排队中的普通文本");

  queue.disable();
  assert.deepEqual(await queue.getFollowUpMessages(), []);
  assert.equal(queue.hasPending(), true, "abort 后消息应留给 finally 串行处理");

  queue.reset();
  const messages = await queue.getFollowUpMessages();
  assert.deepEqual(messages.map((message) => message.content), ["排队中的普通文本"]);
  assert.equal(queue.hasPending(), false);
});

test("steering：B1 无独立输入通道，恒返回空数组", async () => {
  const queue = createFollowUpController();
  queue.enqueue("普通文本");
  assert.deepEqual(await queue.getSteeringMessages(), []);
  assert.equal(queue.hasPending(), true, "steering 不得消费 follow-up 队列");
});

test("clear：丢弃全部待处理行（/exit 与空闲中断）", () => {
  const queue = createFollowUpController();
  queue.enqueue("/exit");
  queue.enqueue("残留");
  queue.clear();
  assert.equal(queue.hasPending(), false);
});
