#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 通过 tsx 启动单一 CLI 入口，使 workspace bin 无需全局 tsx。
 *
 * @param {string[]} argv 转发给 CLI 的参数。
 * @returns {import("node:child_process").ChildProcess} 子进程。
 */
function launchCli(argv) {
  const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  return spawn(
    process.execPath,
    ["--import", "tsx", cliPath, ...argv],
    { stdio: "inherit" }
  );
}

const child = launchCli(process.argv.slice(2));
child.on("error", (error) => {
  process.stderr.write(`golden-studio launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
