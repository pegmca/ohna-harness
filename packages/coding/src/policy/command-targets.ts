/**
 * 写目标与受保护目录判定：命令策略里「这条命令会写到哪里」的纯函数集合。
 *
 * 从 command-rules 拆出的原因：规则文件已接近单文件上限，而写目标解析（~ / $HOME 展开、
 * 受保护根 realpath、重定向目标）是一个内聚的子领域，单独成模块便于逐条单测。
 * 调用方仍从 command-rules 导入（那里做了 re-export），公共 API 不变。
 */
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { resolveEffectiveCommand, unquote } from "./command-normalize.js";
import { canonicalizePath } from "../support/paths.js";

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

/**
 * 受保护的系统目录：向其写入一律拒绝。
 *
 * 不收录 `/private`：macOS 的 tmpdir 就位于 `/private/var/folders/...`，
 * 宽泛收录会把真实工作区内的写入/删除误判。`/etc` ↔ `/private/etc`
 * 这类 firmlink 差异由 targetsProtectedRoot 的双侧 realpath 对齐，无需列举别名。
 */
const PROTECTED_ROOTS = ["/etc", "/usr", "/System", "/Library", "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys"];

/**
 * 把目标 token 展开为可比较的路径字面量。
 *
 * 覆盖 `~`、`$HOME`、`${HOME}` 三种 shell 写法及其子路径；`~user` 无法在不解析
 * passwd 的前提下安全展开，保持原样交给规则层拒绝。其余变量（`$PWD`、`$FOO`）
 * 与命令替换属于运行期语义，本函数不做猜测。
 *
 * @param token 目标 token。
 * @returns 归一化后的目标字面量。
 */
export function expandTarget(token: string): string {
  const target = unquote(token);
  const home = homedir();
  if (target === "~" || target === "$HOME" || target === "$" + "{HOME}") {
    return home;
  }
  if (target.startsWith("~/")) {
    return home + target.slice(1);
  }
  // `$HOME/Documents` 与 `${HOME}/Documents`：去掉变量名部分后保留前导斜杠。
  if (target.startsWith("$HOME/")) {
    return home + target.slice("$HOME".length);
  }
  if (target.startsWith("$" + "{HOME}/")) {
    return home + target.slice("${HOME}".length);
  }
  return target;
}

/**
 * 判断目标是否落在受保护的系统目录内。
 *
 * 判定前对目标和受保护根都做 realpath：macOS 上 `/etc` 实际是 `/private/etc`，
 * 只比较字面量会把 `/etc/passwd` 的别名写法漏掉；反过来，工作区自身若位于
 * `/private/var/folders/...`，也不会因为根目录清单里的 `/private` 被误伤。
 *
 * @param target 目标字面量。
 * @returns 命中受保护目录时为 true。
 */
export function targetsProtectedRoot(target: string): boolean {
  if (!isAbsolute(target)) {
    return false;
  }
  const normalized = canonicalizePath(resolve(target));
  return PROTECTED_ROOTS.some((root) => {
    const protectedPath = canonicalizePath(resolve(root));
    return normalized === protectedPath || normalized.startsWith(protectedPath + sep);
  });
}

/** 只把「最后一个操作数」当写目标的复制 / 移动类命令（其余操作数是源）。 */
const LAST_OPERAND_WRITE_VERBS = new Set(["mv", "cp", "install", "ln"]);

/** 输出重定向操作符（含 `>|` 强制覆盖与 `2>` 这类 fd 前缀）。 */
const OUTPUT_REDIRECT_PATTERN = /^\d*(>>|>\||>)$/;

/** fetch 类命令；与 command-rules 的 FETCH_COMMANDS 同义，本地定义以避免运行时循环依赖。 */
const FETCH_WRITE_COMMANDS = new Set(["curl", "wget"]);

/** 带 scheme 的 URL 字面量，用于推断远端默认文件名。 */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 解析 token 内联的重定向写目标：`>/etc/foo`、`>>build.log`、`>|/etc/foo`、`2>/etc/foo`。
 *
 * 词法层不会把 `>` 与紧随其后的路径拆开（`echo x >/etc/foo` 只有一个 token），
 * 因此写目标扫描必须自己拆。`>&1` / `2>&1` 是 fd 复制而不是文件路径，返回 null。
 *
 * @param token 原始 token。
 * @returns 去引号后的目标字面量；不是内联写重定向时为 null。
 */
function parseInlineWriteRedirect(token: string): string | null {
  const match = /^\d*(>>|>\||>)(.+)$/.exec(token);
  if (!match) {
    return null;
  }
  const target = unquote(match[2]);
  if (target.length === 0 || target.startsWith("&")) {
    return null;
  }
  return target;
}

/**
 * 判断 token 是否是选项或重定向符号，不参与操作数收集。
 *
 * @param token 原始 token。
 * @returns 选项 / 重定向符号时为 true。
 */
function isOptionOrRedirect(token: string): boolean {
  return (
    token.startsWith("-") ||
    OUTPUT_REDIRECT_PATTERN.test(token) ||
    token === "<" ||
    parseInlineWriteRedirect(token) !== null
  );
}

/** 支持 `-t` / `--target-directory` 显式目标目录的写动词。 */
const EXPLICIT_TARGET_VERBS = new Set(["cp", "mv", "install", "ln"]);

/**
 * 解析 `cp -t DIR` / `--target-directory=DIR` 这类显式目标目录。
 *
 * 为什么要单独处理：`cp -t /etc x` 里 `/etc` 是唯一写入目标、`x` 是源文件，
 * 只取「最后一个操作数」会把 `x` 当目标而放行。GNU 组合短选项要求 `-t`
 * 位于末尾（`cp -vt DIR`），因此只把 `-t` 结尾的短选项簇视为目标目录选项。
 *
 * @param args 有效命令的参数（已展开包装器）。
 * @returns 展开后的目标目录字面量；未指定 `-t` 时为 null。
 */
function findExplicitTargetDirectory(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const raw = unquote(args[i]);
    if (raw === "--") {
      // `--` 之后全是操作数，`-t` 不再具有选项语义。
      return null;
    }
    if (raw === "--target-directory") {
      const value = args[i + 1];
      return value === undefined ? null : expandTarget(value);
    }
    if (raw.startsWith("--target-directory=")) {
      return expandTarget(raw.slice("--target-directory=".length));
    }
    // `-t DIR`、`-tDIR` 与组合短选项 `-vt DIR` / `-vtDIR`：t 之后整段都是取值。
    // 必须用「首个 t」而不是贪婪回溯到目录名里的 t（`-t/etc` 的残留不能是 `c`）。
    const short = /^-([A-Za-z]*)t(.*)$/.exec(raw);
    if (short) {
      // $2 是 t 之后的取值（`-t/etc` → `/etc`）；没有 $2 时取下一个 token。
      if (short[2].length > 0) {
        return expandTarget(short[2]);
      }
      const value = args[i + 1];
      return value === undefined ? null : expandTarget(value);
    }
  }
  return null;
}

/**
 * 收集一段命令的所有写入目标：写动词的绝对路径操作数与重定向目标。
 *
 * 写动词同样走有效命令解析：`/bin/rm`、`env rm`、`command rm` 的操作数都要参与
 * 受保护目录判断；只扫描「有效 head」而不是任意 token，避免把 `grep rm file`
 * 的参数误当成写命令。
 *
 * `cp` / `mv` / `install` / `ln` 的最后一个操作数才是目标（其余是源文件），
 * 因此 `cp /etc/passwd ./copy.txt` 不应把读取的源文件误判成系统目录写入；
 * 显式 `-t DIR` / `--target-directory=DIR` 时 DIR 是唯一目标（G1）；
 * `tee` 仍按多目标处理，`sed -i` / `chmod` / `chown` 保持保守（所有操作数都检查）。
 *
 * @param tokens 单段命令 token 列表。
 * @returns 写入目标字面量列表。
 */
export function collectWriteTargets(tokens: string[]): string[] {
  const targets: string[] = [];
  const { head, args, tokens: effectiveTokens } = resolveEffectiveCommand(tokens);

  if (WRITE_VERBS.has(head)) {
    const operands = args.filter((operand) => !isOptionOrRedirect(operand));
    let selected = operands.map(expandTarget);
    if (LAST_OPERAND_WRITE_VERBS.has(head)) {
      const explicit = EXPLICIT_TARGET_VERBS.has(head) ? findExplicitTargetDirectory(args) : null;
      selected = explicit !== null ? [explicit] : selected.slice(-1);
    }
    targets.push(...selected);
  }

  // 重定向片段可能出现在任意位置：echo x > /etc/foo、cat a >> b 等。
  // 无空格写法（`echo x >/etc/foo`）在词法层是一个 token，由 parseInlineWriteRedirect 拆出。
  for (let i = 0; i < effectiveTokens.length; i++) {
    const token = effectiveTokens[i];
    const inline = parseInlineWriteRedirect(token);
    if (inline !== null) {
      targets.push(expandTarget(inline));
      continue;
    }
    if (OUTPUT_REDIRECT_PATTERN.test(token)) {
      const next = effectiveTokens[i + 1];
      if (next) {
        targets.push(expandTarget(next));
      }
    }
  }

  return targets.filter((target) => target.length > 0);
}

/**
 * 从 URL 推断远端落盘文件名：取 pathname 末段，忽略查询串。
 *
 * @param url 带 scheme 的 URL 字面量。
 * @returns 文件名；URL 非法时为 null（无法推断，交给确认闸门）。
 */
function inferRemoteName(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    if (pathname.endsWith("/")) {
      // 目录形式的 URL 由服务端决定文件名，按 wget 默认值保守推断。
      return "index.html";
    }
    const name = basename(pathname);
    return name.length > 0 ? name : "index.html";
  } catch {
    return null;
  }
}

/**
 * 收集 fetch（curl / wget）的落盘目标：`-o` / `--output` / `--output=` / `-O`
 * 与 wget 无 `-O` 时按 URL 推断的默认文件名。
 *
 * 返回未解析的目标字面量（相对路径保持相对）：protected-write 规则直接送入
 * `targetsProtectedRoot`；fetch → 解释器同路径判定在 command-fetch 里 resolve 后比较。
 *
 * @param tokens 单段命令 token 列表。
 * @returns 落盘目标字面量列表；非 fetch 命令返回空数组。
 */
export function collectFetchWriteTargets(tokens: string[]): string[] {
  const { head, args } = resolveEffectiveCommand(tokens);
  if (!FETCH_WRITE_COMMANDS.has(head)) {
    return [];
  }
  const targets: string[] = [];
  let hasOutputDocument = false;

  const add = (value: string | undefined): void => {
    if (value === undefined) {
      return;
    }
    const target = unquote(value);
    // `-` 表示 stdout / stderr，不是文件目标。
    if (target.length === 0 || target === "-") {
      return;
    }
    targets.push(expandTarget(target));
  };

  const addRemoteName = (): void => {
    const url = args.map(unquote).find((token) => URL_PATTERN.test(token));
    if (url === undefined) {
      return;
    }
    const name = inferRemoteName(url);
    if (name !== null) {
      targets.push(name);
    }
  };

  for (let i = 0; i < args.length; i++) {
    const raw = unquote(args[i]);
    if (OUTPUT_REDIRECT_PATTERN.test(raw)) {
      add(args[i + 1]);
      i += 1;
      continue;
    }
    if (head === "curl") {
      if (raw === "-o" || raw === "--output") {
        add(args[i + 1]);
        i += 1;
        continue;
      }
      if (raw.startsWith("--output=")) {
        add(raw.slice("--output=".length));
        continue;
      }
      // `-oFILE`：短选项与取值相连。
      if (raw.startsWith("-o") && raw.length > 2) {
        add(raw.slice(2));
        continue;
      }
      if (raw === "-O" || raw === "--remote-name") {
        addRemoteName();
      }
      continue;
    }
    // wget 的大写 -O 才是输出文件；`-o` 是日志文件。
    if (raw === "-O" || raw === "--output-document") {
      hasOutputDocument = true;
      add(args[i + 1]);
      i += 1;
      continue;
    }
    if (raw.startsWith("--output-document=")) {
      hasOutputDocument = true;
      add(raw.slice("--output-document=".length));
      continue;
    }
    if (raw.startsWith("-O") && raw.length > 2) {
      hasOutputDocument = true;
      add(raw.slice(2));
    }
  }

  // wget 未指定 -O 时默认按 URL 末段落盘，必须纳入同一集合。
  if (head === "wget" && !hasOutputDocument) {
    for (const token of args.map(unquote)) {
      if (!URL_PATTERN.test(token)) {
        continue;
      }
      const name = inferRemoteName(token);
      if (name !== null) {
        targets.push(name);
      }
    }
  }

  return targets.filter((target) => target.length > 0);
}
