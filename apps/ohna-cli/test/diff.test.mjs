/**
 * diff 纯函数单测：unified diff 形状（增删行、上下文、新文件全 +、hunk 头惯例）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, formatUnifiedDiff } from "../dist/ui/diff.js";

test("diffLines：新增、删除与上下文行", () => {
  const lines = diffLines("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(
    lines.map((line) => `${line.type}:${line.text}`),
    ["context:a", "del:b", "add:B", "context:c", "add:d"],
  );
});

test("diffLines：空旧文本（新文件）全为 add", () => {
  const lines = diffLines("", "x\ny");
  assert.ok(lines.length === 2);
  assert.ok(lines.every((line) => line.type === "add"));
});

test("diffLines：无差异返回全 context", () => {
  const lines = diffLines("same\nlines", "same\nlines");
  assert.ok(lines.every((line) => line.type === "context"));
  assert.equal(formatUnifiedDiff("same", "same"), "");
});

test("formatUnifiedDiff：hunk 头遵循 unified 惯例", () => {
  const diff = formatUnifiedDiff("a\nb", "a\nB");
  const body = diff.split("\n");
  assert.equal(body[0], "@@ -1,2 +1,2 @@");
  assert.equal(body[1], " a");
  assert.equal(body[2], "-b");
  assert.equal(body[3], "+B");
});

test("formatUnifiedDiff：新文件全 +，头为 @@ -0,0 +1,N @@", () => {
  const diff = formatUnifiedDiff("", "one\ntwo");
  const body = diff.split("\n");
  assert.equal(body[0], "@@ -0,0 +1,2 @@");
  assert.deepEqual(body.slice(1), ["+one", "+two"]);
});

test("formatUnifiedDiff：删除文件全 -，头为 @@ -1,N +0,0 @@", () => {
  const diff = formatUnifiedDiff("one\ntwo", "");
  const body = diff.split("\n");
  assert.equal(body[0], "@@ -1,2 +0,0 @@");
  assert.deepEqual(body.slice(1), ["-one", "-two"]);
});

test("formatUnifiedDiff：可选 label 出现在头之前", () => {
  const diff = formatUnifiedDiff("a", "b", "src/foo.ts");
  assert.ok(diff.startsWith("src/foo.ts\n@@"));
});
