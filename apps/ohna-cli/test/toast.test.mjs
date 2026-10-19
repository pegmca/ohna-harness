/**
 * Toast 队列单测（Phase C3）：替换 / 排队 / 超时 / 暂停与恢复 / `+N more`。
 *
 * 队列是纯内存状态 + 真实计时器；用短 duration + sleep 观察超时语义，不 mock 时间。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatToastLine, ToastQueue } from "../dist/ui/tui/toast.js";

/** 等待若干毫秒。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("push：显示中且未暂停且无排队 → 直接替换当前条", () => {
  const queue = new ToastQueue();
  try {
    queue.push({ text: "a", duration: 1000 });
    assert.equal(queue.current.text, "a");
    queue.push({ text: "b", duration: 1000 });
    assert.equal(queue.current.text, "b", "未暂停时新 toast 直接替换");
    assert.equal(queue.pending, 0);
  } finally {
    queue.dispose();
  }
});

test("push：显示中但已暂停 / 已有排队 → 入队并计数", () => {
  const queue = new ToastQueue();
  try {
    queue.push({ text: "a", duration: 1000 });
    queue.pause();
    queue.push({ text: "b", duration: 1000 });
    queue.push({ text: "c", duration: 1000 });
    assert.equal(queue.current.text, "a", "暂停时当前条保持");
    assert.equal(queue.pending, 2, "b、c 应排队");
  } finally {
    queue.dispose();
  }
});

test("dismiss：弹出当前条并显示下一条", () => {
  const queue = new ToastQueue();
  try {
    queue.push({ text: "a", duration: 1000 });
    queue.pause();
    queue.push({ text: "b", duration: 1000 });
    queue.dismiss();
    assert.equal(queue.current.text, "b", "下一条应顶上");
    assert.equal(queue.pending, 0);
  } finally {
    queue.dispose();
  }
});

test("超时：duration 到期后自动弹出，队列清空", async () => {
  const queue = new ToastQueue();
  try {
    queue.push({ text: "a", duration: 20 });
    assert.equal(queue.current.text, "a");
    await sleep(70);
    assert.equal(queue.current, undefined, "超时后应自动消失");
  } finally {
    queue.dispose();
  }
});

test("pause / resume：暂停期间不过期，恢复后按剩余时长继续", async () => {
  const queue = new ToastQueue();
  try {
    queue.push({ text: "a", duration: 40 });
    queue.pause();
    await sleep(90);
    assert.equal(queue.current.text, "a", "暂停期间不得超时");
    queue.resume();
    await sleep(90);
    assert.equal(queue.current, undefined, "恢复后应按时消失");
  } finally {
    queue.dispose();
  }
});

test("formatToastLine：有排队时追加 `+N more`", () => {
  const entry = { text: "hello", duration: 5000 };
  assert.equal(formatToastLine(entry, 0), "hello");
  assert.equal(formatToastLine(entry, 2), "hello  +2 more");
});
