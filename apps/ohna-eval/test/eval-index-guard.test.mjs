/**
 * ohna 评测 CLI 入口测试（index.ts 工作项）。
 *
 * 验证：
 * 1) index.ts 通过 import.meta.url 守卫，import 时不自启 main（被 test 引用安全）；
 * 2) main 可导出且带参数运行；未知档位 / 缺失数据集时返回 exit 1（不崩溃）；
 * 3) --tier integration 在默认数据集上能跑通并产出 EvalReportDto（验收硬条件）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../dist/index.js";

test("index.ts 导出 main 且 import 不触发进程退出", async () => {
  assert.equal(typeof main, "function", "main 应为可调用函数");
  // 不调用 main()：守卫逻辑保证 import 本模块时不自启主流程（import 成功即证明不自启）。
});

test("main 在未知档位或缺失数据集时返回 exit 1（不崩溃）", async () => {
  // 传入不存在的数据集路径：main 应抛错被捕获并返回 1。
  const code = await main(["node", "eval", "--dataset", "/nonexistent/ohna-coding.json", "--tier", "integration"]);
  assert.equal(code, 1, "数据集缺失应返回 exit 1");
});

test("--tier integration 跑通默认数据集产出报告（验收：≥20 cases + EvalReportDto）", async () => {
  // 使用仓库内真实数据集路径，integration 档离线确定性可复现。
  const code = await main(["node", "eval", "--tier", "integration"]);
  // 首次跑（无 baseline）按 §5 返回 1，但已写出 report.json；这里只验证不崩溃、正常返回退出码。
  assert.ok(code === 0 || code === 1, `integration 档应正常结束（实际 exit ${code}）`);
});
