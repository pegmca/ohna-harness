/**
 * fetch（curl / wget）与解释器的组合规则：F3 / F7 的静态判定。
 *
 * 为什么单独成模块：`command-policy.ts` 负责「切片段 → 逐规则编排」，而
 * 「下载内容是否会被执行」需要一套自己的形状识别（管道 / 落盘同路径 / 解释器 payload），
 * 与通用 denylist 原语不是同一内聚域。拆出后编排文件保持在单文件上限内。
 *
 * 判定只看三种形状（F7）：
 * 1. 管道链上任一 stage 是 fetch（含 F3 的解释器 payload 形式），链的最右 stage 是解释器；
 * 2. fetch 通过 `-o` / `-O` / 重定向写出文件，后续解释器的脚本操作数解析到同一路径；
 * 3. 命令替换 / 进程替换中的 fetch（由 command-policy 的 checkFetchCommandSubstitution 负责）。
 *
 * 边界：路径只做 `resolve` 归一，不追软链；fetch 之后出现无关解释器（`curl x; node build.js`）
 * 不再拒绝，避免把正常的「下载 + 构建」误判成一键脚本。
 */
import { resolve } from "node:path";
import {
  splitTopLevel,
  stripComments,
  tokenizePiece,
  type CommandPiece,
  FETCH_COMMANDS,
  SHELL_INTERPRETERS,
} from "./command-rules.js";
import { isQuoteBalanced, resolveEffectiveCommand, unquote } from "./command-normalize.js";
import { collectFetchWriteTargets } from "./command-targets.js";

/** 规则命中结果（与 command-policy 共用形状，纯类型 import 不产生运行时依赖）。 */
export type RuleHit = { reason: string; rule: string };

/** 解释器内联脚本的提取结果：没有内联脚本、成功提取、或 payload 畸形需保守拒绝。 */
export type PayloadResult =
  | { kind: "none" }
  | { kind: "payload"; text: string }
  | { kind: "malformed"; detail: string };

/**
 * 提取解释器的内联脚本：`sh -c "<script>"` 或 `eval "<script>"`。
 *
 * 引号不配对 / payload 无法完整解析时返回 malformed，而不是当作普通命令放行：
 * `bash -c "bash -c \"rm -rf /\""` 这类嵌套转义一旦被截断，静态分析就看不到真实命令，
 * 保守拒绝比猜测安全。
 *
 * @param args 有效命令的参数（已展开包装器与 env -S）。
 * @param head 有效命令名（需已确认在 SHELL_INTERPRETERS 中）。
 * @returns payload 提取结果。
 */
export function extractInterpreterPayload(args: string[], head: string): PayloadResult {
  if (head === "eval") {
    // eval 的 payload 可能被 tokenize 拆成多个 token，按空格拼回原命令语义。
    if (args.some((token) => !isQuoteBalanced(token))) {
      return { kind: "malformed", detail: "eval payload has unbalanced quotes" };
    }
    const payload = args.map(unquote).join(" ").trim();
    return payload.length > 0 ? { kind: "payload", text: payload } : { kind: "none" };
  }

  for (let i = 0; i < args.length; i++) {
    const token = unquote(args[i]);
    // 同时覆盖 `-c` 与组合短选项 `-lc` / `-ec`。
    if (token === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(token)) {
      const rawPayload = args[i + 1];
      if (rawPayload === undefined) {
        return { kind: "none" };
      }
      if (!isQuoteBalanced(rawPayload)) {
        return { kind: "malformed", detail: "inline script has unbalanced quotes" };
      }
      const payload = unquote(rawPayload).trim();
      if (payload.length === 0) {
        return { kind: "none" };
      }
      if (!isQuoteBalanced(payload)) {
        return { kind: "malformed", detail: "inline script has unbalanced quotes after unquoting" };
      }
      return { kind: "payload", text: payload };
    }
  }
  return { kind: "none" };
}

/**
 * 判断一段命令是否是「网络取内容」：head 为 curl/wget，或解释器 `-c` payload 的顶层命令是 fetch。
 *
 * `sh -c "curl x" | sh` 的左侧 head 是 sh，只看 head 会漏掉真正的下载动作。
 *
 * @param tokens 单段命令 token。
 * @returns 命中 fetch 时为 true。
 */
function isFetchPiece(tokens: string[]): boolean {
  const { head, args } = resolveEffectiveCommand(tokens);
  if (FETCH_COMMANDS.has(head)) {
    return true;
  }
  if (!SHELL_INTERPRETERS.has(head)) {
    return false;
  }
  const payload = extractInterpreterPayload(args, head);
  if (payload.kind !== "payload") {
    return false;
  }
  // 只看 payload 顶层：`sh -c "curl x"` 是 fetch；`sh -c "echo curl"` 不是。
  return splitTopLevel(stripComments(payload.text)).some((piece) => {
    const pieceTokens = tokenizePiece(piece.text);
    return pieceTokens.length > 0 && FETCH_COMMANDS.has(resolveEffectiveCommand(pieceTokens).head);
  });
}

/**
 * 收集 fetch 命令通过文件写出的绝对路径：`curl -o` / `curl -O` / `wget -O` / 重定向。
 *
 * 只在后续解释器的脚本操作数解析到同一路径时拒绝（F7 条件 2），
 * 避免 `curl x; node build.js` 这类无关命令被误伤。落盘目标的词法解析统一在
 * `command-targets.collectFetchWriteTargets`，这里只负责按 cwd 解析成绝对路径，
 * 保证「protected-write」与「同路径执行」两条规则看到完全一致的目标集合。
 *
 * @param tokens 单段命令 token。
 * @param cwd 当前工作目录，用于解析相对路径。
 * @returns 归一化后的绝对路径列表。
 */
function collectFetchOutputPaths(tokens: string[], cwd?: string): string[] {
  const base = resolve(cwd ?? process.cwd());
  return collectFetchWriteTargets(tokens).map((target) => resolve(base, target));
}

/**
 * 提取解释器真正会执行的脚本文件操作数。
 *
 * `sh -c "..."` / `eval` 的脚本文本不是文件；`sh -x script.sh` 的 `-x` 不是操作数。
 *
 * @param tokens 单段命令 token。
 * @returns 脚本文件操作数列表（未归一化）。
 */
function collectInterpreterFileOperands(tokens: string[]): string[] {
  const { head, args } = resolveEffectiveCommand(tokens);
  if (!SHELL_INTERPRETERS.has(head)) {
    return [];
  }
  // 内联脚本没有文件操作数；malformed 已由 payload 规则拒绝。
  if (extractInterpreterPayload(args, head).kind !== "none") {
    return [];
  }
  return args
    .map(unquote)
    .filter((token) => token.length > 0 && !token.startsWith("-") && token !== "<" && !/^\d*>>?$/.test(token));
}

/**
 * 检查「网络下载 → 解释器执行」这类一键脚本模式（F7 精确化）。
 *
 * 只拒绝三种形状：
 * 1. `|` 管道链上任一 stage 是 fetch（含解释器 `-c` payload 里的 fetch），最右 stage 是解释器；
 * 2. fetch 通过 `-o` / `-O` / 重定向写出文件，后续解释器的脚本操作数解析到同一路径；
 * 3. 命令替换 / 进程替换中的 fetch（由 checkFetchCommandSubstitution 负责）。
 *
 * 不再因为「之前出现过 fetch」就拒绝后续无关解释器，因此 `curl x; node build.js`
 * 与 `curl x && python3 -c "print(1)"` 保持放行；`curl x -o /tmp/s.sh; sh /tmp/s.sh` 仍拒绝。
 *
 * @param pieces 切分后的命令片段。
 * @param cwd 当前工作目录，用于解析相对路径。
 * @returns 命中原因与规则名，未命中为 null。
 */
export function checkFetchPipedToShell(pieces: CommandPiece[], cwd?: string): RuleHit | null {
  const base = resolve(cwd ?? process.cwd());
  const fetchedFiles = new Set<string>();

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const tokens = tokenizePiece(piece.text);
    if (tokens.length === 0) {
      continue;
    }

    const { head } = resolveEffectiveCommand(tokens);
    if (isFetchPiece(tokens)) {
      for (const target of collectFetchOutputPaths(tokens, cwd)) {
        fetchedFiles.add(target);
      }
    }

    if (!SHELL_INTERPRETERS.has(head)) {
      continue;
    }

    // 条件 1：沿 `|` 管道链向左遍历，任一 stage 是 fetch 即命中。
    // 只比较紧邻前一段会漏掉 `curl x | tee /tmp/s.sh | sh`、`curl x | cat | sh`；
    // 链在 `;` / `&&` / `||` 处自然终止（这些片段的 operator 不是 `|`）。
    if (piece.operator === "|") {
      for (let cursor = i - 1; cursor >= 0 && pieces[cursor + 1].operator === "|"; cursor--) {
        const stageTokens = tokenizePiece(pieces[cursor].text);
        if (stageTokens.length > 0 && isFetchPiece(stageTokens)) {
          return {
            reason: "Downloaded content is piped into " + head + " and may execute arbitrary code",
            rule: "fetch-piped-to-shell",
          };
        }
      }
    }

    // 条件 2：fetch 落盘路径与解释器脚本操作数一致。
    for (const operand of collectInterpreterFileOperands(tokens)) {
      const absolute = resolve(base, operand);
      if (fetchedFiles.has(absolute)) {
        return {
          reason: "Downloaded file (" + absolute + ") is executed by " + head + " and may run arbitrary code",
          rule: "fetch-piped-to-shell",
        };
      }
    }
  }

  return null;
}
