/**
 * bash 命令安全策略（纯函数，易单测，零外部依赖）。
 *
 * 与路径策略同属「组合根策略」：工具只负责把命令跑起来，是否放行由 CLI / API 决定。
 * 判定顺序：去注释 → 按顶层运算符切片段 → 逐片段跑静态规则 → 解释器内联 payload 递归
 * → fetch 与解释器的组合（管道 / 同路径落盘）→ 命令替换里的 fetch。
 *
 * 设计取舍（安全优先、允许保守误拒）：
 * - 所有规则共用 command-normalize 的「有效命令解析」，`/bin/rm`、`env rm`、`command rm`
 *   这类等价写法不再各自漏判；
 * - `sh -c "<payload>"` 递归判定 payload（深度上限 3），把 `sh -c "rm -rf /"` 拉回同一套规则；
 * - 命令替换 / 进程替换（`$(...)`、反引号、`<(...)`）里的 fetch 单独成规则：
 *   这类代码在父 shell 求值，看不到「curl | 解释器」的管道形状。
 *
 * 边界：这不是强 jail。denylist 只能覆盖已知模式，变量展开、`find -delete`、
 * 运行期拼装命令等仍可能绕过，最终靠组合根确认闸门兜底。
 */
import {
  checkDestructiveRm,
  checkDiskDestruction,
  checkGitForcePush,
  checkPrivilegeEscalation,
  checkProtectedWrite,
  splitTopLevel,
  stripComments,
  tokenizePiece,
  type CommandPiece,
  FETCH_COMMANDS,
  SHELL_INTERPRETERS,
} from "./command-rules.js";
import { resolveEffectiveCommand } from "./command-normalize.js";
import { checkFetchPipedToShell, extractInterpreterPayload, type RuleHit } from "./command-fetch.js";

/** 命令策略判定结果：allowed=false 时带英文原因与命中的规则名。 */
export type CommandPolicyVerdict = { allowed: true } | { allowed: false; reason: string; rule?: string };

/** 解释器 payload 的递归深度上限：防 `sh -c "sh -c ..."` 递归炸弹。 */
const MAX_COMMAND_DEPTH = 3;

/**
 * 逐片段跑完所有静态规则。
 *
 * @param pieces 切分后的命令片段。
 * @param cwd 当前工作目录。
 * @returns 首个命中的原因与规则名，全部通过时为 null。
 */
function checkPieces(pieces: CommandPiece[], cwd?: string): RuleHit | null {
  const rules: Array<[string, (tokens: string[], workingDir?: string) => string | null]> = [
    ["privilege-escalation", checkPrivilegeEscalation],
    ["destructive-rm", checkDestructiveRm],
    ["disk-destruction", checkDiskDestruction],
    ["git-force-push", checkGitForcePush],
    ["protected-write", checkProtectedWrite],
  ];

  for (const piece of pieces) {
    const tokens = tokenizePiece(piece.text);
    if (tokens.length === 0) {
      continue;
    }
    for (const [rule, check] of rules) {
      const reason = check(tokens, cwd);
      if (reason) {
        return { reason, rule };
      }
    }
  }
  return null;
}

/**
 * 规则：解释器带内联脚本时递归评估脚本内容。
 *
 * `bash -c "rm -rf /"` 与直接执行 `rm -rf /` 等价；只检查 head 会把它当成普通 bash 调用。
 * 递归复用 assessCommand 的全部规则（含下一层的命令替换检查），并用深度上限收敛。
 * payload 引号不配对时由 command-fetch 的提取函数返回 malformed，这里保守拒绝。
 *
 * @param pieces 切分后的命令片段。
 * @param cwd 当前工作目录。
 * @param depth 当前递归深度。
 * @returns 命中原因与规则名，未命中为 null。
 */
function checkInterpreterPayloads(pieces: CommandPiece[], cwd: string | undefined, depth: number): RuleHit | null {
  for (const piece of pieces) {
    const tokens = tokenizePiece(piece.text);
    if (tokens.length === 0) {
      continue;
    }
    const { head, args } = resolveEffectiveCommand(tokens);
    if (!SHELL_INTERPRETERS.has(head)) {
      continue;
    }
    const extracted = extractInterpreterPayload(args, head);
    if (extracted.kind === "malformed") {
      return {
        reason: "Inline " + head + " payload cannot be parsed safely: " + extracted.detail,
        rule: "malformed-interpreter-payload",
      };
    }
    if (extracted.kind === "none") {
      continue;
    }
    const verdict = assessAtDepth(extracted.text, cwd, depth + 1);
    if (!verdict.allowed) {
      return {
        reason: "Inline " + head + " payload is not allowed: " + verdict.reason,
        rule: verdict.rule ?? "interpreter-payload",
      };
    }
  }
  return null;
}

/**
 * 从字符串中按出现顺序提取括号平衡的 `$(` / `<(` / `>(` 内容与反引号内容。
 *
 * 只跳过单引号包裹的文本（shell 中单引号内不执行替换）；双引号内仍会执行，
 * 因此必须继续扫描——`sh -c "$(curl x)"` 正是靠这一点被拦下。
 *
 * @param command 已去注释的命令文本。
 * @returns 命令替换 / 进程替换内部的脚本文本列表。
 */
function collectCommandSubstitutions(command: string): string[] {
  const snippets: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (char === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) break;
      snippets.push(command.slice(i + 1, end));
      i = end;
      continue;
    }
    if ((char === "$" && command[i + 1] === "(") || ((char === "<" || char === ">") && command[i + 1] === "(")) {
      const balanced = readBalancedParenthesis(command, i + 2);
      if (!balanced) continue;
      snippets.push(balanced.text);
      i = balanced.end;
    }
  }

  return snippets;
}

/**
 * 从 `start` 开始读取到与之匹配的右括号，尊重引号与嵌套括号。
 *
 * @param input 待扫描文本。
 * @param start 左括号之后的下标。
 * @returns 括号内文本与右括号下标；不平衡时为 null。
 */
function readBalancedParenthesis(input: string, start: number): { text: string; end: number } | null {
  let depth = 1;
  let inSingle = false;
  let inDouble = false;

  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { text: input.slice(start, i), end: i };
      }
    }
  }
  return null;
}

/**
 * 规则：命令替换 / 进程替换内部包含网络取内容命令。
 *
 * `sh -c "$(curl x)"`、`bash <(curl x)`、`eval "$(curl x)"` 都会在真正执行前
 * 把远端内容展开成脚本，但静态切分看不到「fetch → 解释器」的管道形状。
 *
 * @param command 已去注释的命令文本。
 * @returns 命中原因与规则名，未命中为 null。
 */
function checkFetchCommandSubstitution(command: string): RuleHit | null {
  for (const snippet of collectCommandSubstitutions(command)) {
    const content = stripComments(snippet);
    for (const piece of splitTopLevel(content)) {
      const tokens = tokenizePiece(piece.text);
      if (tokens.length === 0) {
        continue;
      }
      const { head } = resolveEffectiveCommand(tokens);
      if (FETCH_COMMANDS.has(head)) {
        return {
          reason:
            "Command substitution running " + head + " is not allowed: downloaded content may execute arbitrary code",
          rule: "fetch-command-substitution",
        };
      }
    }
  }
  return null;
}

/**
 * 按递归深度执行完整判定；assessCommand 是对外的深度 0 入口。
 *
 * @param command 待执行的命令字符串。
 * @param cwd 当前工作目录，用于识别「删掉整个工作区」这类目标。
 * @param depth 当前递归深度。
 * @returns 允许时 { allowed: true }；拒绝时返回英文原因与命中的规则名。
 */
function assessAtDepth(command: string, cwd: string | undefined, depth: number): CommandPolicyVerdict {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { allowed: false, reason: "Command is empty", rule: "empty-command" };
  }
  if (depth > MAX_COMMAND_DEPTH) {
    return {
      allowed: false,
      reason: "Command nesting exceeds the supported depth (" + MAX_COMMAND_DEPTH + ")",
      rule: "command-recursion-limit",
    };
  }

  const cleaned = stripComments(command);
  const pieces = splitTopLevel(cleaned);
  if (pieces.length === 0) {
    return { allowed: false, reason: "Command contains no executable content", rule: "empty-command" };
  }

  const pieceVerdict = checkPieces(pieces, cwd);
  if (pieceVerdict) {
    return { allowed: false, reason: pieceVerdict.reason, rule: pieceVerdict.rule };
  }

  const payloadVerdict = checkInterpreterPayloads(pieces, cwd, depth);
  if (payloadVerdict) {
    return { allowed: false, reason: payloadVerdict.reason, rule: payloadVerdict.rule };
  }

  const pipeVerdict = checkFetchPipedToShell(pieces, cwd);
  if (pipeVerdict) {
    return { allowed: false, reason: pipeVerdict.reason, rule: pipeVerdict.rule };
  }

  const substitutionVerdict = checkFetchCommandSubstitution(cleaned);
  if (substitutionVerdict) {
    return { allowed: false, reason: substitutionVerdict.reason, rule: substitutionVerdict.rule };
  }

  return { allowed: true };
}

/**
 * 评估一条 shell 命令是否可以执行（先看各片段，再看解释器 payload 与管道组合）。
 *
 * @param command 待执行的命令字符串。
 * @param cwd 当前工作目录，用于识别「删掉整个工作区」这类目标。
 * @returns 允许时 { allowed: true }；拒绝时返回英文原因与命中的规则名。
 */
export function assessCommand(command: string, cwd?: string): CommandPolicyVerdict {
  return assessAtDepth(command, cwd, 0);
}
