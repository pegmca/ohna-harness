import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliCommand } from "./args.js";
import { parseCliArguments } from "./args.js";
import type { CommandOutcome } from "./output.js";
import {
  printFailure,
  printSuccess,
  projectCommandResult,
  projectError
} from "./output.js";
import { runCommand } from "./commands.js";

/**
 * 执行唯一 CLI 入口。
 *
 * 该文件只负责组合参数解析、命令分派与表现层；业务语义全部在 core，
 * 参数与输出模块也仅服务这一入口。
 *
 * @param argv 不含 node 与脚本路径的 CLI 参数。
 * @returns 进程退出码；成功为 0，失败为 1。
 */
export async function runCli(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  let command: CliCommand | null = null;
  try {
    const parsed = parseCliArguments(argv);
    command = parsed.command;
    const outcome = projectCommandResult(
      parsed.command,
      await runCommand(parsed)
    );
    if (outcome.ok) {
      printSuccess(parsed.command, outcome, parsed.json);
      return 0;
    }
    printFailure(parsed.command, outcome as CommandOutcome, parsed.json);
    return 1;
  } catch (error) {
    printFailure(command, projectError(error), json);
    return 1;
  }
}

/** 直接执行守卫；导入 runCli 时不得触发进程退出或输出。 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `internal_error: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
