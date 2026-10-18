#!/usr/bin/env node
/**
 * CLI 入口：仅负责参数解析与 --help 打印，真实模型装配与运行交由 harness.runCli。
 * 手动解析（不引入第三方参数库）：支持 --model / --prompt 的长选项与 = 等值写法，
 * 以及位置参数作为单次问题；--help 优先于其它逻辑。
 */
import type { CliMode } from "./mode.js";
import { runCli, type CliOptions } from "./harness.js";

/** 合法运行模式集合，用于 --mode 取值校验。 */
const MODES: readonly CliMode[] = ["research", "coding"];

/** 需要取值的长选项 → 对应的选项字段名，避免参数解析写成一长串 if/else。 */
const VALUE_FLAGS: ReadonlyMap<string, "model" | "prompt" | "mode"> = new Map([
  ["--model", "model"],
  ["--prompt", "prompt"],
  ["--mode", "mode"],
]);

/**
 * 把命令行 token 拆成 flag 与内联值，统一 --key=value 与 --key 两种写法。
 * 例如 "--mode=coding" → ["--mode", "coding"]，"--mode" → ["--mode", undefined]。
 *
 * @param arg 原始命令行 token。
 * @returns [flag, 内联值]；无 = 时内联值为 undefined。
 */
function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
}

/**
/**
 * 校验 --mode 取值：只接受 research / coding，非法值回退 research 并给出中文告警，
 * 保证老用法（不带 --mode）行为完全不变。
 *
 * @param raw 命令行上原样传入的模式字符串。
 * @returns 合法的运行模式；传入 undefined 或非法值时返回 research。
 */
function parseMode(raw: string | undefined): CliMode {
  if (!raw) return "research";
  const matched = MODES.find((mode) => mode === raw);
  if (matched) return matched;
  process.stderr.write(`未知运行模式 "${raw}"，已回退为 research（可选值：${MODES.join(" / ")}）。\n`);
  return "research";
}

/**
 * 解析命令行参数（process.argv 去掉前两项后的部分）。
 * 规则：--help / -h 置 help；--model / --prompt / --mode 可取下一参数或 = 等值；
 * --yes 为布尔开关（跳过写/执行确认）；其余位置参数合并为单次 prompt（仅在未显式 --prompt 时生效）。
 *
 * @param argv 已剥离 node 与脚本路径后的参数列表。
 * @returns 结构化 CLI 选项。
 */
function parseArgs(argv: string[]): CliOptions {
  const parsed: { model?: string; prompt?: string; mode?: string } = {};
  let yes = false;
  let help = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }

    // 两种写法等价：--mode=coding 与 --mode coding。
    const [flag, inlineValue] = splitFlag(arg);
    const key = VALUE_FLAGS.get(flag);
    if (key) {
      let value = inlineValue;
      if (value === undefined) {
        value = argv[i + 1];
        i += 1;
      }
      parsed[key] = value;
      continue;
    }

    positional.push(arg);
  }

  if (parsed.prompt === undefined && positional.length > 0) {
    parsed.prompt = positional.join(" ");
  }

  return { model: parsed.model, prompt: parsed.prompt, help, mode: parseMode(parsed.mode), yes };
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
    "编码模式（M1）：",
    "  immersive --mode coding \"你的需求\"    用编码工具集（read/write/edit/bash/grep/find/ls）完成任务",
    "  immersive --mode coding --yes \"…\"     跳过写文件与执行命令前的 y/n 确认（批处理用）",
    "  immersive --mode coding              进入编码 REPL（多轮上下文保留）",
    "",
    "说明：",
    "  --mode 可选 research（默认，金融研究）与 coding（编码助手）；缺省保持原有金融问答行为。",
    "  coding 模式的工作区为当前目录：路径越界与危险命令会被拒绝，不传 --yes 时写/执行需终端确认。",
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
