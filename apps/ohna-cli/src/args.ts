/**
 * CLI 参数解析：纯函数 + 可注入告警输出，便于单测非法数字 / 缺失取值等边界。
 *
 * 不引入第三方参数库：参数面很小，手写解析能精确控制「错误只告警、不崩溃」的产品语义。
 * 入口文件 index.ts 只负责调用 parseArgs / printHelp / runCli，不再夹带解析逻辑。
 */
/** CLI 入口参数（已解析）。 */
export interface CliOptions {
  model?: string;
  prompt?: string;
  help: boolean;
  /** true 表示 --yes：跳过写文件与执行命令的交互确认。 */
  yes: boolean;
  /** --resume <id>：恢复已有会话。 */
  resume?: string;
  /** --max-turns <n>：单次 run 的最大回合数（缺省 MAX_TURNS）。 */
  maxTurns?: number;
  /** --deadline-ms <n>：单次 run 的墙钟上限。 */
  deadlineMs?: number;
  /** --max-cost <n>：会话累计成本上限（美元）。 */
  maxCost?: number;
  /** --web [dir]：进程内托管模式（ohna --web，D8 主路径）。 */
  web: boolean;
  /** --web 的位置参数：工作区目录；缺省 cwd。 */
  webDir?: string;
  /** --web-port <n>：托管端口；缺省 4173（占用自动 +1）。 */
  webPort: number;
  /** --no-open：--web 模式不自动打开浏览器。 */
  open: boolean;
  /** --mcp <config.json>：外部 MCP server 配置文件路径。 */
  mcpConfig?: string;
}

/** --web 模式的默认端口（与 ohna-api 一致）。 */
export const DEFAULT_WEB_PORT = 4173;

/** 取值选项的字段名（字符串原样收集，数字在解析末尾统一校验）。 */
type ValueFlagKey =
  | "model"
  | "prompt"
  | "resume"
  | "maxTurns"
  | "deadlineMs"
  | "maxCost"
  | "webPort"
  | "mcpConfig";

/** 需要取值的长选项 → 对应的选项字段名，避免参数解析写成一长串 if/else。 */
const VALUE_FLAGS: ReadonlyMap<string, ValueFlagKey> = new Map([
  ["--model", "model"],
  ["--prompt", "prompt"],
  ["--resume", "resume"],
  ["--max-turns", "maxTurns"],
  ["--deadline-ms", "deadlineMs"],
  ["--max-cost", "maxCost"],
  ["--web-port", "webPort"],
  ["--mcp", "mcpConfig"],
]);

/** 默认告警输出：写 stderr，保持 stdout 只有可管道消费的正常输出。 */
function defaultWarn(message: string): void {
  process.stderr.write(message);
}

/**
 * 把命令行 token 拆成 flag 与内联值，统一 --key=value 与 --key 两种写法。
 *
 * @param arg 原始命令行 token。
 * @returns [flag, 内联值]；无 = 时内联值为 undefined。
 */
function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
}

/**
 * 判断 token 是否是另一个选项（避免取值选项吞掉下一个开关）。
 *
 * 覆盖三类：长选项 `--*`、短开关 `-h` / `-y`（含 `-hy` 组合）、以及其它字母开头的短选项；
 * 但负数字面量（`-5`、`-0.5`）仍交给数字校验，让 `--max-cost -1` 得到「需要非负数」而不是
 * 「缺少取值」这种误导性告警。
 *
 * @param token 待判断的命令行 token。
 * @returns 是选项时返回 true。
 */
function isOptionToken(token: string): boolean {
  if (token.startsWith("--")) return true;
  return token.length > 1 && token.startsWith("-") && !/^-\d/.test(token);
}

/**
 * 解析正整数参数；非法值打印中文告警并返回 undefined（忽略该参数，不崩溃）。
 *
 * @param raw 命令行原值。
 * @param flag 参数名（用于告警文案）。
 * @param warn 告警输出。
 * @returns 合法正整数或 undefined。
 */
function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  warn: (message: string) => void,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  warn(`参数 ${flag} 需要正整数，已忽略："${raw}"。\n`);
  return undefined;
}

/**
 * 解析非负小数参数（成本允许 0）；非法值打印中文告警并返回 undefined。
 *
 * @param raw 命令行原值。
 * @param flag 参数名（用于告警文案）。
 * @param warn 告警输出。
 * @returns 合法非负数或 undefined。
 */
function parseNonNegativeNumber(
  raw: string | undefined,
  flag: string,
  warn: (message: string) => void,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  warn(`参数 ${flag} 需要非负数，已忽略："${raw}"。\n`);
  return undefined;
}

/**
 * 解析命令行参数（process.argv 去掉前两项后的部分）。
 *
 * 取值规则：
 * - `--key=value` 与 `--key value` 等价；`--help` / `--yes` 为开关；
 * - `--key` 后面紧跟另一个以 `-` 开头的选项 token（`--*`、`-h`、`-y` 等）时视为「缺少取值」：
 *   中文告警并忽略该选项，绝不吞掉下一个 flag（否则 `--max-turns --yes` / `--max-turns -h`
 *   会把开关当作取值，导致 help 丢失或数字校验误报）；
 * - 位置参数合并为单次 prompt。
 *
 * @param argv 已剥离 node 与脚本路径后的参数列表。
 * @param warn 告警输出（测试注入收集器）。
 * @returns 结构化 CLI 选项。
 */
export function parseArgs(
  argv: string[],
  warn: (message: string) => void = defaultWarn,
): CliOptions {
  const parsed: Partial<Record<ValueFlagKey, string>> = {};
  let yes = false;
  let help = false;
  let web = false;
  let open = true;
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
    if (arg === "--web") {
      web = true;
      continue;
    }
    if (arg === "--no-open") {
      open = false;
      continue;
    }

    // 两种写法等价：--resume=abc 与 --resume abc。
    const [flag, inlineValue] = splitFlag(arg);
    const key = VALUE_FLAGS.get(flag);
    if (key) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || isOptionToken(next)) {
          warn(`参数 ${flag} 缺少取值，已忽略。\n`);
          continue;
        }
        value = next;
        i += 1;
      }
      if (value === "") {
        warn(`参数 ${flag} 缺少取值，已忽略。\n`);
        continue;
      }
      parsed[key] = value;
      continue;
    }

    positional.push(arg);
  }

  // --web [dir]：托管模式下第一个位置参数是工作区目录（不是 prompt），
  // 其余位置参数按原规则合并为 prompt（web 模式忽略）。
  const promptPositional = [...positional];
  let webDir: string | undefined;
  if (web && promptPositional.length > 0) {
    webDir = promptPositional.shift();
  }
  const prompt = parsed.prompt ?? (promptPositional.length > 0 ? promptPositional.join(" ") : undefined);

  return {
    model: parsed.model,
    prompt,
    help,
    yes,
    resume: parsed.resume,
    maxTurns: parsePositiveInt(parsed.maxTurns, "--max-turns", warn),
    deadlineMs: parsePositiveInt(parsed.deadlineMs, "--deadline-ms", warn),
    maxCost: parseNonNegativeNumber(parsed.maxCost, "--max-cost", warn),
    web,
    webDir,
    webPort: parsePositiveInt(parsed.webPort, "--web-port", warn) ?? DEFAULT_WEB_PORT,
    open,
    mcpConfig: parsed.mcpConfig,
  };
}

/**
 * 打印中文用法说明。
 *
 * @param write 输出函数（默认 stdout，便于测试捕获）。
 */
export function printHelp(write: (text: string) => void = (text) => process.stdout.write(text)): void {
  const text = [
    "用法：",
    "  ohna                          启动交互式 REPL（多轮上下文保留）",
    "  ohna \"你的问题\"             单次提问后退出",
    "  ohna --prompt \"你的问题\"     单次提问后退出（等价写法）",
    "  ohna --model deepseek         选择指定 profile 的真实模型",
    "  ohna --help                   打印本帮助",
    "",
    "编码能力（M1）：",
    "  工具集：read / write / edit / bash / grep / find / ls（作用域限定在当前工作目录）",
    "  ohna \"你的需求\" --yes         跳过写文件与执行命令前的 y/n 确认（批处理用）",
    "",
    "长任务治理（M2）：",
    "  ohna --resume <id>             恢复已保存的会话（启动/退出时会打印当前 id）",
    "  ohna --max-turns <n>           单次 run 的最大回合数（缺省 24）",
    "  ohna --deadline-ms <n>         单次 run 的墙钟上限（毫秒，从 run 开始计时）",
    "  ohna --max-cost <n>            会话累计成本上限（美元；run 前 + 每轮后检查，单轮内可能超出）",
    "  会话内 /cost                  查看本会话累计 input/output token 与成本",
    "  会话每轮结束自动保存到 ~/.ohna/sessions/<id>.jsonl（纯 JSONL，可 cat）",
    "",
    "体验与扩展（M3）：",
    "  会话内 /model [profile]       无参列出可用 profile 与当前；带参切换模型（对后续 run 生效）",
    "  会话内 /compact               立即对当前会话做一次上下文压缩",
    "  会话内 /tools                 列出当前工具（MCP 工具标注来源）",
    "  会话内 /resume [id]           无参列出最近会话；带参切换会话",
    "  ohna --mcp <config.json>      挂载外部 MCP server：{\"servers\":[{\"command\",\"args\"?,\"env\"?,\"name\"?}]}",
    "  ohna --web [dir]              进程内托管本地 Web UI（终端与浏览器看同一会话）",
    "  ohna --web --web-port <n>     指定托管端口（默认 4173，占用自动 +1）",
    "  ohna --web --no-open          不自动打开浏览器",
    "",
    "说明：",
    "  工作区为当前目录：路径越界与危险命令会被拒绝，不传 --yes 时写/执行需终端确认。",
    "  达到 max-turns / deadline / max-cost 时打印「⏹ 已停止：…」并干净退出当前 run。",
    "  --max-cost 0 表示零预算：run 开始前即停止，不调用模型。",
    "  本 CLI 只走真实大模型，已彻底移除 mock。未配置任何真实 provider 时将报错并以非零码退出。",
    "  可用 profile：deepseek / openrouter / bridge_ai，由 .env 中的 AIAGENT_LLM_*_<PROFILE> 配置。",
    "  模型元数据可用 AIAGENT_LLM_CONTEXT_WINDOW_<P> / MAX_TOKENS_<P> / REASONING_<P> /",
    "  COST_IN_<P> / COST_OUT_<P> 覆盖（否则 context=128000、maxTokens=8192、cost=0）。",
    "",
  ];
  write(text.join("\n") + "\n");
}
