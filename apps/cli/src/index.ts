#!/usr/bin/env node
/**
 * CLI 入口：仅负责参数解析与 --help 打印，真实模型装配与运行交由 harness.runCli。
 * 手动解析（不引入第三方参数库）：支持 --model / --prompt 的长选项与 = 等值写法，
 * 以及位置参数作为单次问题；--help 优先于其它逻辑。
 */
import { runCli, type CliOptions } from "./harness.js";

/**
 * 解析命令行参数（process.argv 去掉前两项后的部分）。
 * 规则：--help / -h 置 help；--model / --prompt 可取下一参数或 = 等值；
 * 其余位置参数合并为单次 prompt（仅在未显式 --prompt 时生效）。
 *
 * @param argv 已剥离 node 与脚本路径后的参数列表。
 * @returns 结构化 CLI 选项。
 */
function parseArgs(argv: string[]): CliOptions {
  let model: string | undefined;
  let prompt: string | undefined;
  let help = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--model") {
      model = argv[i + 1];
      i += 1;
    } else if (arg === "--prompt") {
      prompt = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
    } else {
      positional.push(arg);
    }
  }

  if (prompt === undefined && positional.length > 0) {
    prompt = positional.join(" ");
  }

  return { model, prompt, help };
}

/** 打印中文用法说明。 */
function printHelp(): void {
  const text = [
    "用法：",
    "  immersive                          启动交互式 REPL（多轮上下文保留）",
    "  immersive \"你的问题\"             单次提问后退出",
    "  immersive --prompt \"你的问题\"     单次提问后退出（等价写法）",
    "  immersive --model deepseek         选择指定 profile 的真实模型",
    "  immersive --help                   打印本帮助",
    "",
    "说明：",
    "  本 CLI 只走真实大模型，已彻底移除 mock。未配置任何真实 provider 时将报错并以非零码退出。",
    "  可用 profile：deepseek / openrouter / bridge_ai，由 .env 中的 AIAGENT_LLM_*_<PROFILE> 配置。",
    "",
  ];
  process.stdout.write(text.join("\n") + "\n");
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
} else {
  runCli(options).catch((error) => {
    process.stderr.write(`\nCLI 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
