/** CLI 支持的子命令。 */
export const CLI_COMMANDS = [
  "mine",
  "validate",
  "promote",
  "generate",
  "serve",
  "doctor"
] as const;

/** 合法子命令联合类型。 */
export type CliCommand = (typeof CLI_COMMANDS)[number];

/** 严格解析后的 CLI 参数。 */
export interface CliArguments {
  command: CliCommand;
  json: boolean;
  workspace?: string;
  corpus?: string;
  batch?: string;
  candidates?: string;
  golden: boolean;
}

/** 各命令允许的选项集合。 */
const COMMAND_OPTIONS: Record<CliCommand, ReadonlySet<string>> = {
  mine: new Set(["--json", "--workspace", "--corpus", "--batch", "--candidates"]),
  validate: new Set(["--json", "--workspace", "--corpus", "--batch", "--golden"]),
  promote: new Set(["--json", "--workspace", "--corpus", "--batch"]),
  generate: new Set(["--json", "--workspace", "--corpus"]),
  serve: new Set(["--json", "--workspace", "--corpus"]),
  doctor: new Set(["--json", "--workspace", "--corpus"])
};

/** CLI 参数与边界错误。 */
export class CliError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  /**
   * @param code 稳定错误码。
   * @param message 可展示说明。
   * @param details 机器可读详情。
   * @param cause 原始异常。
   */
  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

/**
 * 严格解析 CLI 参数，拒绝位置参数、重复选项与跨命令选项。
 *
 * @param argv 不含 node 与脚本路径的参数。
 * @returns 已校验参数。
 * @throws {CliError} 命令或选项不符合命令契约时抛出。
 */
export function parseCliArguments(argv: string[]): CliArguments {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [rawCommand, ...tokens] = normalizedArgv;
  if (!rawCommand) {
    throw new CliError("missing_command", "A subcommand is required.");
  }
  if (!isCommand(rawCommand)) {
    throwingCommand(rawCommand);
  }
  const command = rawCommand as CliCommand;
  const parsed: CliArguments = { command, json: false, golden: false };
  const seen = new Set<string>();
  const allowed = COMMAND_OPTIONS[command];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    validateToken(token, command, allowed, seen);
    seen.add(token);
    if (token === "--json" || token === "--golden") {
      setBooleanOption(parsed, token);
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("-")) {
      throw new CliError(
        "missing_option_value",
        `Option ${token} requires a value.`
      );
    }
    assignValue(parsed, token, value);
    index += 1;
  }
  validateRequiredOptions(parsed);
  return parsed;
}

/**
 * 校验选项 token 的形状、命令归属与重复使用。
 *
 * @param token 当前 token。
 * @param command 当前命令。
 * @param allowed 命令允许的选项。
 * @param seen 已消费选项。
 * @throws {CliError} token 不合法时抛出。
 */
function validateToken(
  token: string,
  command: CliCommand,
  allowed: ReadonlySet<string>,
  seen: ReadonlySet<string>
): void {
  if (!token.startsWith("-")) {
    throw new CliError(
      "unexpected_positional",
      `Unexpected positional argument: ${token}.`
    );
  }
  if (!allowed.has(token)) {
    throw new CliError(
      knownOption(token) ? "option_not_allowed" : "unknown_option",
      `Option ${token} is not valid for ${command}.`
    );
  }
  if (seen.has(token)) {
    throw new CliError(
      "duplicate_option",
      `Option ${token} may only be provided once.`
    );
  }
}

/**
 * 设置无值开关。
 *
 * @param parsed 目标参数。
 * @param option 开关名。
 */
function setBooleanOption(
  parsed: CliArguments,
  option: "--json" | "--golden"
): void {
  if (option === "--json") parsed.json = true;
  else parsed.golden = true;
}

/**
 * 判断值是否为合法子命令。
 *
 * @param value 输入值。
 * @returns 是 CLI_COMMANDS 成员时为 true。
 */
function isCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

/**
 * 抛出未知命令或未知顶层选项。
 *
 * @param value 第一个 CLI 参数。
 */
function throwingCommand(value: string): never {
  if (value.startsWith("-")) {
    throw new CliError("unknown_option", `Unknown option: ${value}.`);
  }
  throw new CliError("unknown_command", `Unknown command: ${value}.`);
}

/**
 * 写入一个字符串选项值。
 *
 * @param parsed 目标参数。
 * @param option 选项名。
 * @param value 字符串值。
 */
function assignValue(
  parsed: CliArguments,
  option: string,
  value: string
): void {
  if (option === "--workspace") parsed.workspace = value;
  else if (option === "--corpus") parsed.corpus = value;
  else if (option === "--batch") parsed.batch = value;
  else parsed.candidates = value;
}

/**
 * 校验命令级必填项与互斥选项。
 *
 * @param parsed 已解析参数。
 * @throws {CliError} 缺少必填项或选项冲突时抛出。
 */
function validateRequiredOptions(parsed: CliArguments): void {
  if (parsed.command === "mine" && !parsed.candidates) {
    throw new CliError("missing_option", "mine requires --candidates <file>.");
  }
  if (parsed.command === "promote" && !parsed.batch) {
    throw new CliError("missing_option", "promote requires --batch <name>.");
  }
  if (parsed.command !== "validate") return;
  if (parsed.golden && parsed.batch) {
    throw new CliError(
      "option_conflict",
      "validate accepts either --batch or --golden, not both."
    );
  }
  if (!parsed.golden && !parsed.batch) {
    throw new CliError(
      "missing_option",
      "validate requires exactly one of --batch <name> or --golden."
    );
  }
}

/**
 * 判断选项是否属于任一命令。
 *
 * @param value 选项文本。
 * @returns 至少有一个命令接受时为 true。
 */
function knownOption(value: string): boolean {
  return Object.values(COMMAND_OPTIONS).some((options) => options.has(value));
}
