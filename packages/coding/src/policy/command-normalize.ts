/**
 * 命令词法归一：把一段 token 解析成「真正被执行的有效命令」。
 *
 * 为什么单独成模块：命令策略的每条规则（提权 / rm / 磁盘 / 强制推送 / 写目标）都必须基于
 * 同一个「有效 head」，否则 `/bin/rm`、`env rm`、`command rm` 这类等价写法只要漏归一一条，
 * 就会成为整条 denylist 的绕过入口。把解析收敛到单一函数，规则层只消费结果。
 *
 * 归一规则：
 * - 绝对 / 相对路径形式的命令取 basename（`/bin/rm` → `rm`）；
 * - 跳过 `FOO=bar` 形式的环境变量赋值；
 * - 跳过 `env` / `command` / `exec` / `nohup` / `time` 包装器及其选项，直到找到真正命令；
 * - 补齐 `nice` / `timeout` / `setsid` / `stdbuf` 这组「代理执行」包装器；
 * - `env -S` / `--split-string` 的自变量本身是一条命令行，先按 shell 词法拆词再继续归一，
 *   否则 `env -S "rm -rf /"` 会把 payload 当成一个普通选项值跳过；
 * - 剥离子 shell 分组在 head 位置的括号（`(sh)`、`((sh))`、`(sh -s)`），参数中的括号保持原样。
 *
 * 边界：这里只做静态词法归一，不展开 shell 变量、不解析命令替换（那属于运行期语义，
 * 交给 command-policy 的递归判定与确认闸门兜底）。
 */
import { basename } from "node:path";

/** 会「代理执行」下一个命令的包装器；它们的选项不属于真正命令的参数。 */
const WRAPPER_COMMANDS = new Set(["env", "command", "exec", "nohup", "time", "nice", "timeout", "setsid", "stdbuf"]);

/** shell 变量赋值形式，`env FOO=bar cmd` 与 `FOO=bar cmd` 都要跳过。 */
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `env -S` 的内联命令最多重新展开多少层，防止构造递归 token 流。 */
const MAX_INLINE_EXPANSIONS = 8;

/** 需要额外吞掉一个参数值的包装器选项（`--opt=value` 形式自身已是一个 token）。 */
const WRAPPER_OPTIONS_WITH_ARGUMENT: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  exec: new Set(["-a"]),
  command: new Set(),
  nohup: new Set(),
  // nice -n 5 / nice --adjustment=5；裸 `-10` 是选项自身，不吞值。
  nice: new Set(["-n", "--adjustment"]),
  // timeout 除 duration 外还会吞 signal / kill-after 的值。
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  setsid: new Set(),
  // stdbuf -o 0 需要吞值；`-o0` 已自带值，不会命中这里的精确匹配。
  stdbuf: new Set(["-o", "-e", "-i", "--output", "--error", "--input"]),
};

/** 有效命令解析结果。 */
export interface EffectiveCommand {
  /** 归一化后的命令名（basename）；没有可执行命令时为空串。 */
  head: string;
  /** 真正命令的第一个参数在 `tokens` 中的下标（`tokens` 已展开 `env -S`）。 */
  argsStart: number;
  /** 归一后的 token 流；`env -S` 的内联命令已被词法展开。 */
  tokens: string[];
  /** 真正命令的参数（= `tokens.slice(argsStart)`），规则层直接消费，避免自行切片错位。 */
  args: string[];
}

/**
 * 判断双引号内某个反斜杠转义是否生效（shell 只对这五类字符生效）。
 *
 * @param char 反斜杠后的字符。
 * @returns 该字符会被反斜杠转义时为 true。
 */
export function isDoubleQuoteEscapable(char: string | undefined): boolean {
  return char === '"' || char === "\\" || char === "$" || char === "`" || char === "\n";
}

/**
 * 去掉 token 最外层的双引号，并还原双引号内的反斜杠转义。
 *
 * shell 在双引号里只把 `\"`、`\\`、`\$`、`` \` ``、`\<newline>` 视为转义；
 * 其他反斜杠保持字面量。只有「整体被双引号包裹」的 token 才去引号，
 * `"a"b` 这类拼接 token 保持原样，避免误伤路径。
 *
 * @param token 原始 token（可能带最外层引号）。
 * @returns 去引号后的文本。
 */
function stripDoubleQuotes(token: string): string | null {
  if (token.length < 2 || token[0] !== '"') {
    return null;
  }
  let result = "";
  for (let i = 1; i < token.length; i++) {
    const char = token[i];
    if (char === "\\" && i + 1 < token.length) {
      const next = token[i + 1];
      if (isDoubleQuoteEscapable(next)) {
        result += next;
        i += 1;
        continue;
      }
      result += char;
      continue;
    }
    if (char === '"') {
      // 只有收尾引号位于 token 末尾才算「整体被引号包裹」。
      return i === token.length - 1 ? result : null;
    }
    result += char;
  }
  // 没有闭合引号：保留原文，交给 payload 的保守拒绝逻辑。
  return null;
}

/**
 * 去掉 token 最外层的引号，便于按路径 / 命令名使用。
 *
 * @param token 原始 token。
 * @returns 去引号后的文本。
 */
export function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    if (first === "'" && token[token.length - 1] === "'") {
      // 单引号内没有转义，直接剥离。
      return token.slice(1, -1);
    }
    if (first === '"') {
      const stripped = stripDoubleQuotes(token);
      if (stripped !== null) {
        return stripped;
      }
    }
  }
  return token;
}

/**
 * 判断一段文本的引号是否配对（双引号内尊重反斜杠转义）。
 *
 * `extractInterpreterPayload` 用它识别「payload 被截断 / 引号不配对」的畸形输入；
 * 这类输入无法证明安全，策略层保守拒绝，而不是当成普通命令放行。
 *
 * @param text 待检查文本。
 * @returns 引号全部闭合时为 true。
 */
export function isQuoteBalanced(text: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && isDoubleQuoteEscapable(text[i + 1])) {
        i += 1;
        continue;
      }
      if (char === '"') quote = null;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    }
  }
  return quote === null;
}

/**
 * 按 shell 词法把一段字符串拆成裸词（去掉引号、还原转义）。
 *
 * 供 `env -S` / `--split-string` 使用：这个选项的自变量是「待执行命令行」，
 * 必须先拆词才能看到真正的 head（`env -S "sudo ls"` → `sudo ls`）。
 *
 * @param text 内联命令行文本。
 * @returns 拆分后的裸词列表；空字符串返回空数组。
 */
export function splitShellWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let hasContent = false;
  let quote: "'" | '"' | null = null;

  const flush = (): void => {
    if (hasContent) {
      words.push(current);
    }
    current = "";
    hasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      hasContent = true;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && isDoubleQuoteEscapable(text[i + 1])) {
        current += text[i + 1];
        i += 1;
        hasContent = true;
        continue;
      }
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      hasContent = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasContent = true;
      continue;
    }
    if (char === "\\") {
      const next = text[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
        hasContent = true;
      }
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
    hasContent = true;
  }
  flush();
  return words;
}

/**
 * 判断包装器选项是否还需要吞掉下一个 token 作为参数值。
 *
 * @param wrapper 包装器命令名（已是 basename）。
 * @param option 当前选项 token。
 * @returns 需要跳过下一个 token 时为 true。
 */
function optionTakesArgument(wrapper: string, option: string): boolean {
  return WRAPPER_OPTIONS_WITH_ARGUMENT[wrapper]?.has(option) ?? false;
}

/**
 * 在 `env` 的参数中寻找 `-S` / `--split-string`，并把其 payload 展开成 token。
 *
 * 只处理「env 后面还没出现真正命令」的位置；payload 展开后重新从头归一，
 * 因此 `env -S "env -S \"rm -rf /\""` 这类嵌套也能在展开次数上限内处理。
 *
 * @param tokens 当前 token 流。
 * @param envIndex `env` 在 token 流中的下标。
 * @returns 展开后的 token 流；没有 `-S` 或 payload 为空时为 null。
 */
function expandEnvSplitString(tokens: string[], envIndex: number): string[] | null {
  for (let i = envIndex + 1; i < tokens.length; i++) {
    const raw = unquote(tokens[i]);
    if (raw === "--") {
      return null;
    }
    if (raw === "-S" || raw === "--split-string") {
      const payloadToken = tokens[i + 1];
      if (payloadToken === undefined) {
        return null;
      }
      const words = splitShellWords(unquote(payloadToken));
      if (words.length === 0) {
        return null;
      }
      return [...tokens.slice(0, i), ...words, ...tokens.slice(i + 2)];
    }
    if (raw.startsWith("--split-string=")) {
      const words = splitShellWords(unquote(raw.slice("--split-string=".length)));
      if (words.length === 0) {
        return null;
      }
      return [...tokens.slice(0, i), ...words, ...tokens.slice(i + 1)];
    }
    // `-S"rm -rf /"` / `-Sfoo bar`：短选项与取值直接相连，取值仍在同一个 token 里。
    if (raw.startsWith("-S") && raw.length > 2) {
      const words = splitShellWords(unquote(raw.slice(2)));
      if (words.length === 0) {
        return null;
      }
      return [...tokens.slice(0, i), ...words, ...tokens.slice(i + 1)];
    }
    if (raw.startsWith("-") && raw.length > 1) {
      // `-u NAME` / `-C DIR` 的取值属于 env 自身，不能拿来当 `-S` 候选。
      i += optionTakesArgument("env", raw) ? 1 : 0;
      continue;
    }
    // 已经出现真正命令，`-S` 不可能再出现在合法位置。
    return null;
  }
  return null;
}

/**
 * 反复展开 `env -S`，直到 token 流里没有可展开的内联命令。
 *
 * 不能只看第一个 token：`command env -S "rm -rf /"`、`env FOO=bar env -S "..."`、
 * `timeout 5 env -S "..."` 都把 env 藏在包装器链里。这里沿包装器链定位每一个 env，
 * 命中原样展开后重新扫描。
 *
 * @param tokens 原始 token 流。
 * @returns 展开后的 token 流；没有可展开内容时原样返回。
 */
function expandInlineCommands(tokens: string[]): string[] {
  let current = tokens;
  for (let round = 0; round < MAX_INLINE_EXPANSIONS; round++) {
    let index = 0;
    let expandedThisRound = false;
    while (index < current.length) {
      const token = unquote(current[index]);
      if (ASSIGNMENT_PATTERN.test(token)) {
        index += 1;
        continue;
      }
      const head = basename(token);
      if (head === "env") {
        const expanded = expandEnvSplitString(current, index);
        if (expanded) {
          current = expanded;
          expandedThisRound = true;
          break;
        }
      }
      if (!WRAPPER_COMMANDS.has(head)) {
        break;
      }
      const next = skipWrapper(current, index, head);
      if (next <= index) {
        break;
      }
      index = next;
    }
    if (!expandedThisRound) {
      return current;
    }
  }
  return current;
}

/**
 * 跳过包装器自身与它的选项，定位被包装命令的下标。
 *
 * `command -v` / `command -V` 只查询命令位置、不执行命令，因此直接返回 tokens.length，
 * 避免把查询目标误判成危险命令（例如 `command -v rm` 不应被当成 `rm`）。
 * `timeout` 的第一个非选项参数是 duration，不是要执行的命令，需要单独吞掉。
 *
 * @param tokens 单段命令 token。
 * @param index 包装器所在下标。
 * @param wrapper 包装器命令名。
 * @returns 被包装命令的下标；没有可执行命令时为 tokens.length。
 */
function skipWrapper(tokens: string[], index: number, wrapper: string): number {
  let cursor = index + 1;
  let timeoutDurationSkipped = wrapper !== "timeout";
  while (cursor < tokens.length) {
    const token = unquote(tokens[cursor]);
    if (token === "--") {
      // timeout -- 5 cmd 的 duration 仍在 -- 之后，这里继续按非选项处理。
      cursor += 1;
      continue;
    }
    // 仅 `command -v/-V` 是「查询命令位置」而非执行；其他包装器的 -v 仍会执行后续命令。
    if (wrapper === "command" && (token === "-v" || token === "-V")) {
      return tokens.length;
    }
    // env 允许在命令前继续写赋值：env FOO=bar rm -rf /
    if (ASSIGNMENT_PATTERN.test(token)) {
      cursor += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      cursor += optionTakesArgument(wrapper, token) ? 2 : 1;
      continue;
    }
    if (!timeoutDurationSkipped) {
      // timeout 5 rm -rf /：5 是 duration，跳过后再找真正命令。
      timeoutDurationSkipped = true;
      cursor += 1;
      continue;
    }
    return cursor;
  }
  return tokens.length;
}

/**
 * 判断 token 是否整体被一对括号包裹：`(sh)` 是，`(a) b` 与 `(a)(b)` 不是。
 * 只接受「首字符 `(` 且配对 `)` 恰在末尾」的形状，避免误伤普通参数里的括号。
 *
 * @param token 已去引号的 token。
 * @returns 整体被一对括号包裹时为 true。
 */
function wrapsWholeToken(token: string): boolean {
  if (token.length < 2 || token[0] !== "(" || token[token.length - 1] !== ")") {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "(") {
      depth += 1;
      continue;
    }
    if (token[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        // 外层括号在中间就闭合，说明不是「整体包裹」。
        return i === token.length - 1;
      }
    }
  }
  return false;
}

/**
 * 剥离 head 位置的子 shell 分组括号：`((sh))`、`(sh`、`sh)`、`(sh -s)` 的分组壳。
 *
 * @param token 已去引号的 token。
 * @returns 去括号后的命令名候选。
 */
function stripWrappingParens(token: string): string {
  let result = token.trim();
  while (wrapsWholeToken(result)) result = result.slice(1, -1).trim();
  while (result.startsWith("(")) result = result.slice(1).trim();
  while (result.endsWith(")")) result = result.slice(0, -1).trim();
  return result;
}

/**
 * 去掉子 shell 片段首尾被词法拆开的独立括号。
 * `( bash )` 会被切成 `(`、`bash`、`)`；只按成对数量丢弃，`echo )` 不受影响。
 *
 * @param tokens 单段命令 token 列表。
 * @returns 去掉首尾成对括号后的 token 列表。
 */
function unwrapSubshellTokens(tokens: string[]): string[] {
  let leading = 0;
  while (leading < tokens.length && unquote(tokens[leading]) === "(") {
    leading += 1;
  }
  let trailing = 0;
  while (trailing < tokens.length - leading && unquote(tokens[tokens.length - 1 - trailing]) === ")") {
    trailing += 1;
  }
  return tokens.slice(leading, tokens.length - Math.min(leading, trailing));
}

/**
 * 解析一段命令的「有效命令」：basename + 包装器透传 + `env -S` 内联展开。
 *
 * 子 shell 分组（`(sh)`、`( bash )`、`((sh))`、`(sh -s)`）只剥离包裹括号，不改变语义；
 * 命令名仍取 basename，因此 `curl x | (sh)` 与 `curl x | sh` 进入同一判定。
 *
 * @param tokens 单段命令 token 列表（tokenizePiece 的产物）。
 * @returns 有效命令名、归一后的 token 流与参数；空片段 head 为空串。
 */
export function resolveEffectiveCommand(tokens: string[]): EffectiveCommand {
  const normalized = unwrapSubshellTokens(expandInlineCommands(tokens));
  let index = 0;
  while (index < normalized.length) {
    const token = unquote(normalized[index]);
    // 前导环境变量赋值：`FOO=bar rm -rf /` 里真正命令是 rm。
    if (ASSIGNMENT_PATTERN.test(token)) {
      index += 1;
      continue;
    }
    // 只处理 head 位置上的包裹括号，`git commit -m "fix (sh)"` 的参数不受影响。
    const unwrapped = stripWrappingParens(token);
    if (unwrapped.length === 0) {
      index += 1;
      continue;
    }
    const head = basename(unwrapped);
    if (!WRAPPER_COMMANDS.has(head)) {
      return { head, argsStart: index + 1, tokens: normalized, args: normalized.slice(index + 1) };
    }
    index = skipWrapper(normalized, index, head);
  }
  return { head: "", argsStart: normalized.length, tokens: normalized, args: [] };
}

/**
 * 解析有效命令名（兼容既有调用方；细节见 resolveEffectiveCommand）。
 *
 * @param tokens 单段命令 token 列表。
 * @returns 归一化后的命令名（无 basename 时为空串）。
 */
export function resolveCommandHead(tokens: string[]): string {
  return resolveEffectiveCommand(tokens).head;
}
