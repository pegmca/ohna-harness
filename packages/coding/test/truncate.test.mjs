/**
 * truncate.ts 单元测试：验证工具输出截断的「行数 / 字节」双限制与元数据。
 *
 * 重点覆盖三类边界：未超限原样返回、超限后的截断方向与命中限制类型、
 * 以及极端场景（首行单独超限、末行半行）下的降级标记。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  truncateTail,
} from "../dist/support/truncate.js";

test("默认上限常量与文档一致", () => {
  assert.equal(DEFAULT_MAX_LINES, 2000);
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024);
  assert.equal(GREP_MAX_LINE_LENGTH, 500);
});

test("formatSize 覆盖 B / KB / MB 各量级", () => {
  assert.equal(formatSize(0), "0B");
  assert.equal(formatSize(1), "1B");
  assert.equal(formatSize(512), "512B");
  assert.equal(formatSize(1023), "1023B");
  // 边界：恰好 1024 进入 KB 档并保留一位小数
  assert.equal(formatSize(1024), "1.0KB");
  assert.equal(formatSize(1536), "1.5KB");
  assert.equal(formatSize(1024 * 1023), "1023.0KB");
  assert.equal(formatSize(1024 * 1024), "1.0MB");
  assert.equal(formatSize(1024 * 1024 * 5), "5.0MB");
});

test("truncateHead 空串不截断且计零行", () => {
  const result = truncateHead("");
  assert.equal(result.content, "");
  assert.equal(result.truncated, false);
  assert.equal(result.truncatedBy, null);
  assert.equal(result.totalLines, 0);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.outputLines, 0);
  assert.equal(result.outputBytes, 0);
  assert.equal(result.lastLinePartial, false);
  assert.equal(result.firstLineExceedsLimit, false);
  assert.equal(result.maxLines, DEFAULT_MAX_LINES);
  assert.equal(result.maxBytes, DEFAULT_MAX_BYTES);
});

test("truncateHead 恰好等于上限时不截断", () => {
  // 3 行 6 字节，行数与字节上限都恰好卡在边界
  const result = truncateHead("a\nb\nc", { maxLines: 3, maxBytes: 5 });
  assert.equal(result.truncated, false);
  assert.equal(result.truncatedBy, null);
  assert.equal(result.content, "a\nb\nc");
  assert.equal(result.totalLines, 3);
  assert.equal(result.totalBytes, 5);
  assert.equal(result.outputBytes, 5);
});

test("truncateHead 结尾换行不额外计一行", () => {
  assert.equal(truncateHead("a\nb\nc\n", { maxLines: 10 }).totalLines, 3);
  assert.equal(truncateHead("a\nb\nc", { maxLines: 10 }).totalLines, 3);
  assert.equal(truncateHead("\n", { maxLines: 10 }).totalLines, 1);
  // 中间空行仍然计数
  assert.equal(truncateHead("a\n\nb", { maxLines: 10 }).totalLines, 3);
});

test("truncateHead 超行数上限保留开头并按 lines 标记", () => {
  const result = truncateHead("l1\nl2\nl3\nl4\nl5", { maxLines: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "lines");
  assert.equal(result.content, "l1\nl2\nl3");
  assert.equal(result.outputLines, 3);
  assert.equal(result.totalLines, 5);
  // 输出字节 = 6 个字符 + 2 个换行
  assert.equal(result.outputBytes, 8);
  assert.equal(result.lastLinePartial, false);
});

test("truncateHead 超字节上限按整行停住并按 bytes 标记", () => {
  // 每行 4 字节，字节上限 6 只能完整容纳第一行（第二行含换行共 5 字节，超出）
  const result = truncateHead("aaaa\nbbbb\ncccc", { maxBytes: 6 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.content, "aaaa");
  assert.equal(result.outputLines, 1);
  assert.equal(result.outputBytes, 4);
  assert.equal(result.totalBytes, 14);
});

test("truncateHead 首行单独超字节上限时返回空内容", () => {
  const result = truncateHead("aaaaaaaa\nbb", { maxBytes: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.content, "");
  assert.equal(result.outputLines, 0);
  assert.equal(result.outputBytes, 0);
  assert.equal(result.firstLineExceedsLimit, true);
});

test("truncateHead 按 UTF-8 字节而非字符计数", () => {
  // "中\n文\n" 共 8 字节但只有 5 个字符：字节上限 4 只容得下第一行
  const result = truncateHead("中\n文\n", { maxBytes: 4 });
  assert.equal(result.totalBytes, 8);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.content, "中");
  assert.equal(result.outputBytes, 3);
});

test("truncateTail 未超限时原样返回", () => {
  const result = truncateTail("a\nb\nc", { maxLines: 3, maxBytes: 10 });
  assert.equal(result.truncated, false);
  assert.equal(result.truncatedBy, null);
  assert.equal(result.content, "a\nb\nc");
  assert.equal(result.outputLines, 3);
});

test("truncateTail 超行数上限保留末尾并按 lines 标记", () => {
  const result = truncateTail("l1\nl2\nl3\nl4\nl5", { maxLines: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "lines");
  assert.equal(result.content, "l4\nl5");
  assert.equal(result.outputLines, 2);
  assert.equal(result.totalLines, 5);
});

test("truncateTail 超字节上限保留末尾并按 bytes 标记", () => {
  const result = truncateTail("aaaa\nbbbb", { maxBytes: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.content, "bbbb");
  assert.equal(result.outputBytes, 4);
  assert.equal(result.outputLines, 1);
  assert.equal(result.lastLinePartial, false);
});

test("truncateTail 单行超长时返回半行并标记 lastLinePartial", () => {
  const result = truncateTail("abcdefghij", { maxBytes: 4 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.content, "ghij");
  assert.equal(result.lastLinePartial, true);
  assert.equal(result.outputLines, 1);
  assert.equal(result.outputBytes, 4);
});

test("truncateTail 半行截断不切断多字节字符", () => {
  // "中文测试" 每字 3 字节共 12 字节；保留 5 字节应回退到合法字符起点，不能产出乱码
  const result = truncateTail("中文测试", { maxBytes: 5 });
  assert.equal(result.lastLinePartial, true);
  assert.equal(result.content, "试");
  assert.equal(Buffer.byteLength(result.content, "utf-8"), 3);
  // 回退后的字节数不得超过上限
  assert.ok(result.outputBytes <= 5);
  assert.equal(result.content.includes("\uFFFD"), false);
});

test("truncateLine 单行未超限时原样返回", () => {
  const line = "a".repeat(500);
  const result = truncateLine(line);
  assert.equal(result.wasTruncated, false);
  assert.equal(result.text, line);
});

test("truncateLine 超长单行截断并追加提示", () => {
  const result = truncateLine("a".repeat(600));
  assert.equal(result.wasTruncated, true);
  assert.equal(result.text, "a".repeat(500) + "... [truncated]");
  assert.equal(result.text.length, 500 + "... [truncated]".length);
});

test("truncateLine 支持自定义字符上限", () => {
  assert.equal(truncateLine("abcdef", 3).text, "abc... [truncated]");
  assert.equal(truncateLine("abcdef", 3).wasTruncated, true);
  // 恰好等于上限不截断
  assert.equal(truncateLine("abcdef", 6).wasTruncated, false);
  assert.equal(truncateLine("", 5).text, "");
});
