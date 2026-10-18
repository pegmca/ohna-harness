/**
 * bash 命令安全策略（纯函数，易单测，零外部依赖）。
 *
 * 与路径策略同属「组合根策略」：工具只负责把命令跑起来，是否放行由 CLI / API 决定。
 * 判定顺序：去注释 → 按顶层运算符切片段 → 逐片段跑静态规则 → 再针对管道做「下载即执行」检查。
 * 采用保守策略（宁可误拒）：写动词的任一绝对路径操作数都会参与受保护目录判断；
 * 被拒时返回英文原因，方便模型理解并自行改写命令。
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
  unquote,
  type CommandPiece,
  FETCH_COMMANDS,
  SHELL_INTERPRETERS,
} from "./command-rules.js";

/** 命令策略判定结果：allowed=false 时带英文原因与命中的规则名。 */
export type CommandPolicyVerdict = { allowed: true } | { allowed: false; reason: string; rule?: string };

/**
 * 逐片段跑完所有静态规则。
 *
 * @param pieces 切分后的命令片段。
 * @param cwd 当前工作目录。
 * @returns 首个命中的原因与规则名，全部通过时为 null。
 */
function checkPieces(pieces: CommandPiece[], cwd?: string): { reason: string; rule: string } | null {
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
 * 检查「网络下载 → 管道 → 解释器执行」这类一键脚本模式。
 *
 * @param pieces 切分后的命令片段。
 * @returns 命中原因与规则名，未命中为 null。
 */
function checkFetchPipedToShell(pieces: CommandPiece[]): { reason: string; rule: string } | null {
  const piped = pieces.filter((piece) => piece.operator === null || piece.operator === "|");
  for (let i = 1; i < piped.length; i++) {
    const previous = tokenizePiece(piped[i - 1].text).map(unquote);
    const current = tokenizePiece(piped[i].text).map(unquote);
    if (previous.length === 0 || current.length === 0) {
      continue;
    }
    if (FETCH_COMMANDS.has(previous[0]) && SHELL_INTERPRETERS.has(current[0])) {
      return {
        reason: "Piping downloaded content (" + previous[0] + ") directly into " + current[0] + " is not allowed",
        rule: "fetch-piped-to-shell",
      };
    }
  }
  return null;
}

/**
 * 评估一条 shell 命令是否可以执行（先看各片段，再看管道组合）。
 *
 * @param command 待执行的命令字符串。
 * @param cwd 当前工作目录，用于识别「删掉整个工作区」这类目标。
 * @returns 允许时 { allowed: true }；拒绝时返回英文原因与命中的规则名。
 */
export function assessCommand(command: string, cwd?: string): CommandPolicyVerdict {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { allowed: false, reason: "Command is empty", rule: "empty-command" };
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

  const pipeVerdict = checkFetchPipedToShell(pieces);
  if (pipeVerdict) {
    return { allowed: false, reason: pipeVerdict.reason, rule: pipeVerdict.rule };
  }

  return { allowed: true };
}
