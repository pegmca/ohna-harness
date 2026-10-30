import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * sandbox preload 只能 require Electron 内置模块；外部包会被 Electron 拒绝解析，
 * 导致 contextBridge 未执行、渲染端读到 `window.ohna === undefined`。
 */
test("preload 产物只 require electron，不保留工作区包外链", async () => {
  const source = await readFile(new URL("../dist/preload/index.cjs", import.meta.url), "utf8");
  const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);

  assert.ok(requires.length > 0, "preload 应 require electron");
  assert.deepEqual(
    requires.filter((id) => id !== "electron"),
    [],
    "sandbox preload 不得 require 非 Electron 模块"
  );
});
