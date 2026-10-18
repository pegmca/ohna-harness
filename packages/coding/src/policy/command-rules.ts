/**
 * bash 命令安全策略的「词法与规则」层：static rule primitives of the command policy.
 *
 * 本模块只做纯字符串分析（去注释 → 切片段 → 切 token → 跑单条规则），不负责整体编排；
 * 编排入口在同目录的 command-policy.ts，便于按「规则原语 / 组合策略」两个内聚域分别单测。
 */
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { assertPathWithinRoot } from "./path-policy.js";
import { isDoubleQuoteEscapable, resolveEffectiveCommand, unquote } from "./command-normalize.js";
import { canonicalizePath } from "../support/paths.js";
import { collectFetchWriteTargets, collectWriteTargets, expandTarget, targetsProtectedRoot } from "./command-targets.js";

// 词法原语 / 写目标判定统一由独立模块提供；这里保持原有导出面不变，避免调用方改动。
export { resolveCommandHead, unquote } from "./command-normalize.js";
export {
  collectFetchWriteTargets,
  collectWriteTargets,
  expandTarget,
  targetsProtectedRoot,
} from "./command-targets.js";
// git 子命令规则同样下沉，command-policy 仍按原路径导入。
export { checkGitForcePush } from "./command-git.js";

/** 提权执行器：一律拒绝，Agent 不应获得 root。 */
const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas"]);

/** 磁盘 / 分区级破坏命令名。 */
const DISK_DESTRUCTIVE_PATTERNS: RegExp[] = [/^mkfs(\.\w+)?$/, /^newfs/, /^parted$/, /^fdisk$/, /^diskutil$/];

/** 命令替换 / 进程替换：无法静态求值，rm 目标命中时直接拒绝。 */
const DYNAMIC_SUBSTITUTION_PATTERN = /\$\(|`|<\(|>\(/;

/** 无法安全展开的 `~user` 形式（`~` 与 `~/x` 已由 expandTarget 处理）。 */
const UNEXPANDABLE_TILDE_PATTERN = /^~[^/]/;

/**
 * rm 的危险目标字面量：根、通配、home、当前目录与父目录。
 *
 * `./` / `../` / `../../` 保留字面量便于直接读懂规则；更深的 `..` 前缀变体
 * 由 RM_ANCESTOR_CHAIN 统一判定，避免把无限层级的常量堆进集合。
 */
const RM_DANGEROUS_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "$HOME",
  "${HOME}",
  ".",
  "./",
  "..",
  "../",
  "../../",
  "./*",
  "*",
  "$PWD",
  "${PWD}",
]);

/** 纯父目录链（`../..`、`../../..` 等任意深度）；`./dist` 这类带子路径的目标不命中。 */
const RM_ANCESTOR_CHAIN = /^(?:\.\.\/)*\.\.$/;

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
        if (quote === "'") {
          if (char === "'") quote = null;
          result += char;
          continue;
        }
        if (quote === '"') {
          // 双引号内的 `\"` / `\\` 是转义，不能让 `\"` 提前关闭引号。
          if (char === "\\" && isDoubleQuoteEscapable(line[i + 1])) {
            result += char + line[i + 1];
            i += 1;
            continue;
          }
          if (char === '"') quote = null;
          result += char;
          continue;
        }
        if (char === "\\") {
          // 反斜杠转义下一位，`\#` 不是注释起点。
          result += char + (line[i + 1] ?? "");
          i += 1;
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

    if (quote === "'") {
      if (char === "'") quote = null;
      current += char;
      continue;
    }
    if (quote === '"') {
      // 双引号内的 `\"` 不是结束引号；原样保留转义，便于 unquote 还原。
      if (char === "\\" && isDoubleQuoteEscapable(command[i + 1])) {
        current += char + command[i + 1];
        i += 1;
        continue;
      }
      if (char === '"') quote = null;
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
    if (char === "|" && command[i - 1] === ">" && command[i - 2] !== "\\") {
      // `>|` 是「强制覆盖重定向」而不是管道分隔符（`echo x >|/etc/foo`）。
      current += char;
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

    if (quote === "'") {
      if (char === "'") quote = null;
      current += char;
      continue;
    }
    if (quote === '"') {
      // 双引号内的 `\"` 不是结束引号；保留转义对，unquote 会还原。
      if (char === "\\" && isDoubleQuoteEscapable(text[i + 1])) {
        current += char + text[i + 1];
        i += 1;
        hasContent = true;
        continue;
      }
      if (char === '"') quote = null;
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
 * 规则：拒绝提权执行器。
 *
 * @param tokens 单段命令 token。
 * @returns 命中原因，未命中为 null。
 */
export function checkPrivilegeEscalation(tokens: string[]): string | null {
  // 有效 head：`/usr/bin/sudo`、`command sudo`、`env sudo` 都归一为 sudo。
  const { head } = resolveEffectiveCommand(tokens);
  if (PRIVILEGE_COMMANDS.has(head)) {
    return "Privilege escalation via " + head + " is not allowed";
  }
  return null;
}

/**
 * 归一化 rm 目标：去掉尾部斜杠（保留根 `/`），让 `./` 与 `.`、`../../` 与 `../..` 等价。
 *
 * @param target 已展开的 rm 目标字面量。
 * @returns 归一化后的目标。
 */
function normalizeRmTarget(target: string): string {
  let normalized = target;
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * 判断 rm 目标是否属于「危险根」：根、通配、home、当前目录，或任意深度的纯父目录链。
 *
 * @param target 已展开的 rm 目标字面量。
 * @returns 命中危险目标时为 true。
 */
function isDangerousRmTarget(target: string): boolean {
  const normalized = normalizeRmTarget(target);
  return RM_DANGEROUS_TARGETS.has(normalized) || RM_ANCESTOR_CHAIN.test(normalized);
}

/**
 * 规则：拒绝递归删除危险根（/、~、工作区自身、工作区外目标、受保护系统目录）。
 *
 * 有 cwd 时把相对/绝对/软链目标统一 realpath 到工作区语义：只要目标落在工作区之外，
 * 或等于工作区自身及其祖先，一律拒绝；工作区内的 `./dist` / `node_modules` 正常放行。
 * **工作区边界优先**：工作区位于 `/private/var/...` 等系统前缀下时，删工作区内的
 * `dist` 不能因为系统目录清单被误伤。
 * 无 cwd 时保留固定危险目标 + 受保护系统目录判断（兼容既有调用方与单测）。
 *
 * @param tokens 单段命令 token。
 * @param cwd 当前工作目录，用于识别「删掉工作区之外 / 删掉工作区本身」。
 * @returns 命中原因，未命中为 null。
 */
export function checkDestructiveRm(tokens: string[], cwd?: string): string | null {
  const { head, args } = resolveEffectiveCommand(tokens);
  if (head !== "rm") {
    return null;
  }

  let recursive = false;
  const operands: string[] = [];
  for (const token of args) {
    if (token.startsWith("-") && token.length > 1) {
      if (/[rR]/.test(token)) recursive = true;
      continue;
    }
    if (token === ">" || token === ">>" || token === "<") {
      continue;
    }
    const operand = expandTarget(token);
    // `rm -rf $(pwd)` / 反引号 / 进程替换：操作数只能在运行期求得，可能指向任意目录。
    if (DYNAMIC_SUBSTITUTION_PATTERN.test(operand)) {
      return "Recursive delete with a dynamically evaluated target (" + operand + ") is not allowed";
    }
    // `~user` 需要读 passwd 才能展开，无法安全判定 → 默认拒绝。
    if (UNEXPANDABLE_TILDE_PATTERN.test(operand)) {
      return "Recursive delete of an unexpandable home directory (" + operand + ") is not allowed";
    }
    operands.push(operand);
  }

  if (!recursive) {
    return null;
  }

  const home = homedir();
  for (const operand of operands) {
    // 归一化后再比 home：`~/`、`$HOME/` 与 `~`、`$HOME` 都必须等价拒绝。
    if (normalizeRmTarget(operand) === home || isDangerousRmTarget(operand)) {
      return "Recursive delete of " + operand + " is not allowed";
    }
  }

  if (cwd) {
    // 两侧都 realpath：相对路径、绝对路径与软链因此进入同一套「是否在工作区内」判定。
    const workspaceRoot = canonicalizePath(resolve(cwd));
    for (const operand of operands) {
      const targetPath = canonicalizePath(resolve(workspaceRoot, operand));
      if (targetPath === workspaceRoot) {
        return "Recursive delete targets the workspace root itself (" + operand + ")";
      }
      if (!assertPathWithinRoot(targetPath, workspaceRoot).ok) {
        return "Recursive delete outside the workspace root (" + operand + ") is not allowed";
      }
    }
    // 目标都在工作区内：工作区边界判定优先，不再套用系统目录 denylist。
    return null;
  }

  const homePrefix = home.endsWith(sep) ? home : home + sep;
  for (const operand of operands) {
    if (targetsProtectedRoot(operand)) {
      return "Recursive delete inside protected system directory (" + operand + ") is not allowed";
    }
    // 没有 cwd 时无法证明「在家目录内但属于工作区」，显式绝对路径按危险目标保守拒绝；
    // 相对路径仍按「无法越界」放行，避免把仓库内的 dist / node_modules 误伤。
    if (isAbsolute(operand)) {
      const normalized = resolve(operand);
      if (home !== sep && (normalized === home || normalized.startsWith(homePrefix))) {
        return "Recursive delete inside the home directory (" + operand + ") is not allowed";
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
  // `/sbin/mkfs.ext4`、`/bin/dd`、`env parted` 都归一到同一个有效 head。
  const { head, args } = resolveEffectiveCommand(tokens);
  if (DISK_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(head))) {
    return "Disk or partition modification command (" + head + ") is not allowed";
  }
  if (head === "dd" && args.some((token) => unquote(token).startsWith("of=/dev/"))) {
    return "Writing raw bytes to a block device is not allowed";
  }
  if (head === "diskutil" && args.map(unquote).includes("eraseDisk")) {
    return "Erasing a disk is not allowed";
  }
  return null;
}

/**
 * 规则：拒绝向受保护系统目录或文件系统根写入（含 chmod / chown 等改权限的动作）。
 * 写动词的任一绝对路径操作数命中受保护根即拒，统一判定、无冗余分支
 * （chmod 递归放开系统路径权限会被同一判定覆盖，不必单独成规则）。
 *
 * 写目标来源有三类：写动词操作数、shell 重定向（含无空格 `>/etc/foo`）、
 * fetch 的 `-o` / `--output` / `-O` 落盘。三类共用同一套受保护根判定。
 *
 * 有 cwd 时工作区边界优先：工作区内的路径即使位于系统前缀下（如 macOS tmpdir），
 * 也不因为 denylist 被误伤；根 `/` 本身永远拒绝。
 *
 * @param tokens 单段命令 token。
 * @param cwd 当前工作目录，用于工作区边界优先判定。
 * @returns 命中原因，未命中为 null。
 */
export function checkProtectedWrite(tokens: string[], cwd?: string): string | null {
  // fetch 的 `-o` / `--output` / `-O` 也是落盘写入，与写动词、重定向共用受保护根判定。
  const targets = [...collectWriteTargets(tokens), ...collectFetchWriteTargets(tokens)];
  for (const target of targets) {
    if (isAbsolute(target) && canonicalizePath(resolve(target)) === sep) {
      return "Writing to the filesystem root (" + target + ") is not allowed";
    }
    if (!targetsProtectedRoot(target)) {
      continue;
    }
    if (cwd && assertPathWithinRoot(target, cwd).ok) {
      continue;
    }
    return "Writing to protected system path (" + target + ") is not allowed";
  }
  return null;
}
