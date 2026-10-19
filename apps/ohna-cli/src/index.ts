#!/usr/bin/env node
/**
 * CLI 入口：只做参数解析与 --help 打印，真实模型装配与运行交由 harness.runCli。
 * 解析逻辑在 args.ts（纯函数、可单测），本文件保持极薄，避免入口副作用干扰测试。
 */
import { parseArgs, printHelp } from "./cli/args.js";
import { runCli } from "./cli/harness.js";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
} else {
  runCli(options).catch((error) => {
    process.stderr.write(`\nCLI 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
