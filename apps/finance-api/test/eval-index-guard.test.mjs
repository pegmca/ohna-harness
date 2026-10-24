/**
 * finance-api eval CLI 入口测试（index.ts 工作项）。
 *
 * 验证：index.ts 通过 import.meta.url 守卫，import 时不自启 main（被 test 引用安全）；
 * main() 可导出并带参数运行（此处只验证函数存在与正常导出，不实际触发进程退出）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../dist/eval/index.js";

test("index.ts 导出 main 且 import 不触发进程退出", async () => {
  assert.equal(typeof main, "function", "main 应为可调用函数");
  // 不调用 main()（调用会写盘并可能 process.exit）；仅验证导出形态，
  // 守卫逻辑由 import 该模块时不执行主流程来保证（本测试 import 已成功即证明不自启）。
});

test("main 在未知档位数据集路径下能进入 load 流程（catch 错误而非崩溃）", async () => {
  // 传入一个不存在的数据集路径：main 应抛错被捕获并返回 1（不 crash）。
  const code = await main(["node", "eval", "--dataset", "/nonexistent/finance-rag-v1.json", "--tier", "deterministic"]);
  assert.equal(code, 1, "数据集缺失应返回 exit 1");
});
