/**
 * git 子命令规则：跳过全局选项后判定强制推送。
 *
 * 为什么单独成模块：`git -C repo push --force`、`git -c a=b push -f`、
 * `git --no-pager push --force` 的子命令不在第一个参数，需要一套 git 自己的
 * 选项表；把它与通用 denylist 原语分开，规则文件才能保持在单文件上限内。
 * 调用方仍从 command-rules 导入（那里做了 re-export），公共 API 不变。
 */
import { resolveEffectiveCommand, unquote } from "./command-normalize.js";

/** git 全局选项里需要吞掉下一个 token 的（`-C repo`、`-c a=b`、`--git-dir DIR`）。 */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
  "--attr-source",
]);

/** git 全局选项里自含取值的 `--opt=value` 形式。 */
const GIT_GLOBAL_OPTIONS_WITH_INLINE_VALUE = [
  "--git-dir=",
  "--work-tree=",
  "--namespace=",
  "--exec-path=",
  "--config-env=",
  "--super-prefix=",
  "--attr-source=",
];

/**
 * 跳过 git 全局选项，定位真正的子命令。
 *
 * 为什么需要：`git -C repo push --force`、`git -c a=b push -f`、`git --no-pager push --force`
 * 的子命令不在 `args[0]`，只看第一个参数会把强制推送当成普通 git 调用放行。
 *
 * @param args 有效命令的参数（已去引号）。
 * @returns 子命令与其后的参数；没有子命令时为 null。
 */
function findGitSubcommand(args: string[]): { subcommand: string; rest: string[] } | null {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
        index += 2;
        continue;
      }
      if (GIT_GLOBAL_OPTIONS_WITH_INLINE_VALUE.some((prefix) => token.startsWith(prefix))) {
        index += 1;
        continue;
      }
      // `-Crepo` / `-ca=b`：短选项与取值相连，仍只占一个 token。
      if (/^-[Cc]./.test(token)) {
        index += 1;
        continue;
      }
      // `--no-pager` / `--paginate` / `-p` 等单 token 选项。
      index += 1;
      continue;
    }
    return { subcommand: token, rest: args.slice(index + 1) };
  }
  return null;
}

/**
 * 强制推送的选项前缀：`--force`、`--force-with-lease[=ref]`、`--force-if-includes`。
 * 用前缀而不是精确匹配，`--force=1` / `--force-with-lease=origin` 才不会漏判。
 */
const FORCE_OPTION_PREFIXES = ["--force", "--force-with-lease", "--force-if-includes"];

/**
 * 判断 push 参数里是否包含强制推送语义。
 *
 * @param token push 子命令后的单个参数（已去引号）。
 * @returns 命中 `--force*` / `-f` 组合 / `+ref` 时为 true。
 */
function isForcePushToken(token: string): boolean {
  return (
    FORCE_OPTION_PREFIXES.some((prefix) => token === prefix || token.startsWith(prefix + "=")) ||
    /^-[^-]*f[^-]*$/.test(token) ||
    token.startsWith("+")
  );
}

/**
 * 规则：拒绝强制推送（会覆盖远端历史）。
 *
 * @param tokens 单段命令 token。
 * @returns 命中原因，未命中为 null。
 */
export function checkGitForcePush(tokens: string[]): string | null {
  // push 的位置必须相对有效 head 计算：`/usr/bin/git push --force`、`env git push --force`
  // 的包装器会占用 token 下标，直接看 tokens[1] 会漏判。
  const { head, args: rawArgs } = resolveEffectiveCommand(tokens);
  if (head !== "git") {
    return null;
  }
  const parsed = findGitSubcommand(rawArgs.map(unquote));
  if (!parsed || parsed.subcommand !== "push") {
    return null;
  }
  const forced = parsed.rest.some(isForcePushToken);
  return forced ? "Force pushing is not allowed; use a normal push so remote history is preserved" : null;
}
