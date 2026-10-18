/**
 * ohna-api 参数解析：纯函数 + 可注入告警输出，便于单测。
 *
 * 参数面保持极小：[dir]、--port、--data-dir、--auto-approve、--no-open、--help。
 * 不引入第三方参数库——入口层只需要「解析 + 中文告警」，复杂参数面属于 CLI。
 */

/** 默认监听端口。 */
export const DEFAULT_PORT = 4173;

/** 端口占用时最多尝试的递增次数（与 04 Phase 2 的 +1 重试一致）。 */
export const MAX_PORT_ATTEMPTS = 20;

/** 解析后的选项。 */
export interface OhnaApiOptions {
  /** 工作区目录；缺省 cwd。 */
  dir?: string;
  port: number;
  /** 数据目录；缺省 ~/.ohna。 */
  dataDir?: string;
  autoApprove: boolean;
  /** 是否自动打开浏览器；--no-open 关闭。 */
  open: boolean;
  help: boolean;
}

/** 默认告警输出：写 stderr。 */
function defaultWarn(message: string): void {
  process.stderr.write(message);
}

/**
 * 拆出 `--key=value` 的内联值。
 *
 * @param token 原始 token。
 * @returns [flag, inlineValue]。
 */
function splitFlag(token: string): [string, string | undefined] {
  const index = token.indexOf("=");
  return index > 0 ? [token.slice(0, index), token.slice(index + 1)] : [token, undefined];
}

/**
 * 判断 token 是否是另一个选项，避免取值选项吞掉下一个 flag。
 *
 * @param token 待判断 token。
 * @returns 是选项返回 true。
 */
function isOptionToken(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/**
 * 解析 `--port`：1..65535 的整数，非法时告警并回退默认端口。
 *
 * @param raw 原始值。
 * @param warn 告警输出。
 * @returns 合法端口。
 */
function parsePort(raw: string | undefined, warn: (message: string) => void): number {
  if (raw === undefined) {
    warn("--port 缺少取值，已使用默认端口 4173。\n");
    return DEFAULT_PORT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    warn(`--port 需要 1-65535 的整数，已使用默认端口 ${DEFAULT_PORT}。\n`);
    return DEFAULT_PORT;
  }
  return value;
}

/**
 * 解析命令行参数。
 *
 * @param argv `process.argv.slice(2)`。
 * @param warn 告警输出（测试注入）。
 * @returns 解析后的选项。
 */
export function parseOhnaApiArgs(
  argv: string[],
  warn: (message: string) => void = defaultWarn
): OhnaApiOptions {
  const options: OhnaApiOptions = {
    port: DEFAULT_PORT,
    autoApprove: false,
    open: true,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      if (options.dir === undefined) {
        options.dir = token;
      } else {
        warn(`忽略多余的位置参数：${token}\n`);
      }
      continue;
    }

    const [flag, inlineValue] = splitFlag(token);
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--auto-approve":
        options.autoApprove = true;
        break;
      case "--no-open":
        options.open = false;
        break;
      case "--port": {
        const value = inlineValue ?? (isOptionToken(argv[index + 1] ?? "") ? undefined : argv[++index]);
        options.port = parsePort(value, warn);
        break;
      }
      case "--data-dir": {
        const value = inlineValue ?? (isOptionToken(argv[index + 1] ?? "") ? undefined : argv[++index]);
        if (!value || value.trim() === "") {
          warn("--data-dir 缺少取值，已忽略。\n");
        } else {
          options.dataDir = value;
        }
        break;
      }
      default:
        warn(`未知参数：${token}（已忽略）\n`);
    }
  }

  return options;
}

/**
 * 打印 `--help`。
 *
 * @param write 输出函数。
 */
export function printHelp(write: (message: string) => void = (message) => process.stdout.write(message)): void {
  write(
    [
      "ohna-api · 本地编码 Agent 服务",
      "",
      "用法：",
      "  ohna-api [dir] [options]",
      "",
      "参数：",
      "  [dir]             工作区目录（缺省为当前目录）",
      "  --port <n>        监听端口（默认 4173；占用时自动 +1，最多尝试 20 次）",
      "  --data-dir <dir>  数据目录（默认 ~/.ohna）",
      "  --auto-approve    跳过写/执行确认（默认 write/edit/bash 需在浏览器点允许，L1）",
      "  --no-open         不自动打开浏览器（测试 / 无桌面环境）",
      "  -h, --help        显示本帮助",
      "",
      "环境变量（至少配置一组）：",
      "  AIAGENT_LLM_API_KEY_DEEPSEEK + AIAGENT_LLM_MODEL_DEEPSEEK",
      "  AIAGENT_LLM_API_KEY_OPENROUTER + AIAGENT_LLM_MODEL_OPENROUTER",
      "  AIAGENT_LLM_API_KEY_BRIDGE_AI + AIAGENT_LLM_BASE_URL_BRIDGE_AI + AIAGENT_LLM_MODEL_BRIDGE_AI",
      ""
    ].join("\n")
  );
}
