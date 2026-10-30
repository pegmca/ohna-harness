import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 侧栏只允许纵向滚动：长 workspaceId / 会话标题不得撑出横向滚动条。
 */
test("会话列表与条目带横向溢出约束", async () => {
  const css = await readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
  const conversationList = css.match(/\.conversation-list\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(conversationList, /overflow-x:\s*hidden/);
  assert.match(conversationList, /min-width:\s*0/);

  const title = css.match(/\.conversation-title\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(title, /text-overflow:\s*ellipsis/);
  assert.match(title, /white-space:\s*nowrap/);
});

/**
 * 默认窗口必须给足对话与 Trace 空间，并限制最小尺寸。
 */
test("默认窗口尺寸为 1440x900 且有最小尺寸", async () => {
  const source = await readFile(new URL("../src/main/windows.ts", import.meta.url), "utf8");
  assert.match(source, /width:\s*options\.width \?\? 1440/);
  assert.match(source, /height:\s*options\.height \?\? 900/);
  assert.match(source, /minWidth:\s*960/);
  assert.match(source, /minHeight:\s*640/);
});
