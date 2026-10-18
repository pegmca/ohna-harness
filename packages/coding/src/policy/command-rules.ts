/**
 * bash 命令安全策略的「词法与规则」层：static rule primitives of the command policy.
 *
 * 本模块只做纯字符串分析（去注释 → 切片段 → 切 token → 跑单条规则），不负责整体编排；
 * 编排入口在同目录的 command-policy.ts，便于按「规则原语 / 组合策略」两个内聚域分别单测。
 */
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/** 提权执行器：一律拒绝，Agent 不应获得 root。 */
const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas"]);

/** 磁盘 / 分区级破坏命令名。 */
const DISK_DESTRUCTIVE_PATTERNS: RegExp[] = [/^mkfs(\.\w+)?$/, /^newfs/, /^parted$/, /^fdisk$/, /^diskutil$/];

/** 会落盘写入的命令动词（配合受保护目录判断）。 */
const WRITE_VERBS = new Set([
  "rm",
  "mv",
  "cp",
  "tee",
  "install",
  "dd",
  "chmod",
  "chown",
  "ln",
  "touch",
  "rsync",
  "mkdir",
  "rmdir",
  "truncate",
  "sed",
  "patch",
  "shred",
]);

/** 受保护的系统目录：向其写入一律拒绝。 */
const PROTECTED_ROOTS = ["/etc", "/usr", "/System", "/Library", "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys", "/private"];

/** rm 的危险目标：根、通配、home、当前目录。 */
const RM_DANGEROUS_TARGETS = new Set(["/", "/*", "~", "$HOME", "$" + "{HOME}", ".", "..", "./*", "*", "$PWD"]);

/** 网络取内容的命令，流式 pipe 给解释器时拒绝。 */
export const FETCH_COMMANDS = new Set(["curl", "wget"]);

/** 会把标准输入当脚本执行的解释器。 */
export const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "python", "python3", "perl", "ruby", "node", "eval"]);

/** 顶层切分后的一段命令。 */
export interface CommandPiece {
  /** 该段之前的运算符（&&、||、;、|）；首段为 null。 */
  operator: string | null;
  /** 该段的原始文本。 */
  text: string;
}

/**
 * 去掉 shell 注释（引号内的 # 不算注释），并把换行归一为空格。
 *
 * @param command 原始命令。
 * @returns 不含注释的命令文本。
 */
export function stripComments(command: string): string {
  return command
    .split("\n")
    .map((line) => {
      let result = "";
      let quote: "'" | '"' | null = null;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quote) {
          if (char === quote) quote = null;
          result += char;
          continue;
        }
        if (char === "'" || char === '"') {
          quote = char;
          result += char;
          continue;
        }
        // 未加引号、且位于行首或空白之后的 # 才是注释起点
        if (char === "#" && (result.length === 0 || /\s$/.test(result))) {
          break;
        }
        result += char;
      }
      return result;
    })
    .join(" ")
    .trim();
}

/**
 * 按顶层运算符（&& / || / ; / | / 换行）切分复合命令，引号内的分隔符不参与切分。
 *
 * @param command 已去注释的命令文本。
 * @returns 片段列表，每段携带其前导运算符。
 */
export function splitTopLevel(command: string): CommandPiece[] {
  const pieces: CommandPiece[] = [];
  let current = "";
  let pendingOperator: string | null = null;
  let quote: "'" | '"' | null = null;

  const flush = (): void => {
    const text = current.trim();
    if (text.length > 0) {
      pieces.push({ operator: pendingOperator, text });
    }
    current = "";
    pendingOperator = null;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (char === "|" || char === "&" || char === ";" || char === "\n") {
      const next = command[i + 1] ?? "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) {
        flush();
        pendingOperator = char + next;
        i += 1;
        continue;
      }
      flush();
      pendingOperator = char === "\n" ? ";" : char;
      continue;
    }

    current += char;
  }
  flush();

  return pieces;
}

/**
 * 把单段命令切成 token；保留引号内的空格，并把重定向符号独立成 token。
 *
 * @param text 单段命令文本。
 * @returns token 列表。
 */
export function tokenizePiece(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasContent = false;

  const flush = (): void => {
    if (hasContent) {
      tokens.push(current);
    }
    current = "";
    hasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasContent = true;
      current += char;
      continue;
    }
    if (char === ">" || char === "<") {
      flush();
      current = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === "\\") {
      current += text[i + 1] ?? "";
      hasContent = true;
      i += 1;
      continue;
    }
    current += char;
    hasContent = true;
  }
  flush();

  return tokens;
}

/**
 * 去掉 token 最外层的引号，便于按路径使用。
 *
 * @param token 原始 token。
 * @returns 去引号后的文本。
 */
export function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    if ((first === "'" || first === '"') && token[token.length - 1] === first) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * 把目标 token 展开为可比较的路径字面量（处理 ~ / $HOME；相对路径保持原样）。
 *
 * @param token 目标 token。
 * @returns 归一化后的目标字面量。
 */
export function expandTarget(token: string): string {
  const target = unquote(token);
  if (target === "~" || target === "$HOME" || target === "$" + "{HOME}") {
    return homedir();
  }
  if (target.startsWith("~/")) {
    return homedir() + target.slice(1);
  }
  return target;
}

/**
 * 判断目标是否落在受保护的系统目录内。
 *
 * @param target 目标字面量。
 * @returns 命中受保护目录时为 true。
 */
export function targetsProtectedRoot(target: string): boolean {
  if (!isAbsolute(target)) {
    return false;
  }
  const normalized = resolve(target);
  return PROTECTED_ROOTS.some((root) => normalized === root || normalized.startsWith(root + sep) || normalized === root + sep);
}

/**
 * 收集一段命令的所有写入目标：写动词的绝对路径操作数与重定向目标。
 *
 * @param tokens 单段命令 token 列表。
 * @returns 写入目标字面量列表。
 */
export function collectWriteTargets(tokens: string[]): string[] {
  const targets: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (WRITE_VERBS.has(unquote(token))) {
      for (const operand of tokens.slice(i + 1)) {
        if (operand.startsWith("-") || operand === ">" || operand === ">>" || operand === "<") {
          continue;
        }
        targets.push(expandTarget(operand));
      }
      continue;
    }

    // 重定向片段：echo x > /etc/foo、cat a >> b 等
    if (/^\d*>>?$/.test(token)) {
      const next = tokens[i + 1];
      if (next) {
        targets.push(expandTarget(next));
      }
    }
  }

  return targets.filter((target) => target.length > 0);
}

/**
 * 规则：拒绝提权执行器。
 *
 * @param tokens 单段命令 token。
 * @returns 命中原因，未命中为 null。
 */
export function checkPrivilegeEscalation(tokens: string[]): string | null {
  const head = unquote(tokens[0] ?? "");
  if (PRIVILEGE_COMMANDS.has(head)) {
    return "Privilege escalation via " + head + " is not allowed";
  }
  return null;
}

/**
 * 规则：拒绝递归删除危险根（/、~、工作区自身、受保护系统目录）。
 *
 * @param tokens 单段命令 token。
 * @param cwd 当前工作目录，用于识别「删掉整个工作区」。
 * @returns 命中原因，未命中为 null。
 */
export function checkDestructiveRm(tokens: string[], cwd?: string): string | null {
  if (unquote(tokens[0] ?? "") !== "rm") {
    return null;
  }

  let recursive = false;
  const operands: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-") && token.length > 1) {
      if (/[rR]/.test(token)) recursive = true;
      continue;
    }
    if (token === ">" || token === ">>" || token === "<") {
      continue;
    }
    operands.push(expandTarget(token));
  }

  if (!recursive) {
    return null;
  }

  const home = homedir();
  for (const operand of operands) {
    if (operand === home || RM_DANGEROUS_TARGETS.has(operand)) {
      return "Recursive delete of " + operand + " is not allowed";
    }
    if (targetsProtectedRoot(operand)) {
      return "Recursive delete inside protected system directory (" + operand + ") is not allowed";
    }
  }

  if (cwd) {
    const resolvedCwd = resolve(cwd);
    for (const operand of operands) {
      if (!isAbsolute(operand)) {
        continue;
      }
      const targetPath = resolve(operand);
      // 目标等于工作区或是其祖先，等价于删掉整个项目
      if (targetPath === resolvedCwd || resolvedCwd.startsWith(targetPath + sep)) {
        return "Recursive delete targets the workspace root itself (" + operand + ")";
      }
    }
  }

  return null;
}

/**
 * 规则：拒绝磁盘格式化 / 分区与 dd 直写裸设备。
 *
 * @param tokens 单段命令 token。
 * @returns 命中原因，未命中为 null。
 */
export function checkDiskDestruction(tokens: string[]): string | null {
  const head = unquote(tokens[0] ?? "");
  if (DISK_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(head))) {
    return "Disk or partition modification command (" + head + ") is not allowed";
  }
  if (head === "dd" && tokens.slice(1).some((token) => unquote(token).startsWith("of=/dev/"))) {
    return "Writing raw bytes to a block device is not allowed";
  }
  if (head === "diskutil" && tokens.slice(1).map(unquote).includes("eraseDisk")) {
    return "Erasing a disk is not allowed";
  }
  return null;
}

/**
 * 规则：拒绝强制推送（会覆盖远端历史）。
 *
 * @param tokens 单段命令 token。
 * @returns 命中原因，未命中为 null。
 */
export function checkGitForcePush(tokens: string[]): string | null {
  if (unquote(tokens[0] ?? "") !== "git" || unquote(tokens[1] ?? "") !== "push") {
    return null;
  }
  const rest = tokens.slice(2).map(unquote);
  const forced = rest.some(
    (token) => token === "--force" || token === "--force-with-lease" || /^-[^-]*f[^-]*$/.test(token) || token.startsWith("+"),
  );
  return forced ? "Force pushing is not allowed; use a normal push so remote history is preserved" : null;
}

/**
 * 规则：拒绝向受保护系统目录写入，以及递归放开系统路径权限。
 *
 * @param tokens 单段命令 token。
 * @returns 命中原因，未命中为 null。
 */
/**
 * 规则：拒绝向受保护系统目录写入（含 chmod / chown 等改系统路径权限的动作）。
 * 写动词的任一绝对路径操作数命中受保护根即拒，统一判定、无冗余分支
 * （chmod 递归放开系统路径权限会被同一判定覆盖，不必单独成规则）。
 *
 * @param tokens 单段命令 token。
 * @returns 命中原因，未命中为 null。
 */
export function checkProtectedWrite(tokens: string[]): string | null {
  for (const target of collectWriteTargets(tokens)) {
    if (targetsProtectedRoot(target)) {
      return "Writing to protected system path (" + target + ") is not allowed";
    }
  }
  return null;
}

/**
 * 逐片段跑完所有静态规则。
 *
 * @param pieces 切分后的命令片段。
 * @param cwd 当前工作目录。
 * @returns 首个命中的原因与规则名，全部通过时为 null。
 */
