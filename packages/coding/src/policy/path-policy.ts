/**
 * 路径安全策略（纯函数，零外部依赖，便于单测）。
 *
 * 编码 Agent 最现实的越权风险是「读 /etc/passwd」「改写仓库外的密钥文件」。
 * 这里做两层判断：**越界**（是否在 root 之外）与**敏感**（是否命中密钥 / 环境文件 / 依赖目录）。
 * 策略与工具实现分离：工具只负责能力，是否放行由组合根（CLI / API）决定。
 */
import { basename, extname, resolve, sep } from "node:path";
import { canonicalizePath, normalizePath, resolveFinalSymlinkTarget } from "../support/paths.js";

/** 命中敏感规则时的判定结果。 */
export type PathPolicyVerdict = { ok: true } | { ok: false; reason: string };

/** 命中即拒绝的目录段（路径任意层级）。 */
const DENIED_DIRECTORIES = new Set([".git", "node_modules", ".ssh", ".aws", ".gnupg"]);

/** 命中即拒绝的私钥类扩展名。 */
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore"]);

/** 无扩展名的私钥 / known_hosts 等文件名，落在工作区内也一律拒绝（防 prompt injection 外泄）。 */
const DENIED_KEY_FILENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
  "id_xmss",
  "id_xmss_sk",
  "known_hosts",
  "authorized_keys",
  "authorized_keys2",
  "ssh_host_rsa_key",
  "ssh_host_ecdsa_key",
  "ssh_host_ed25519_key",
]);

/**
 * 归一化成绝对路径：trim、去 @ 前缀、展开 ~、解析相对路径。
 *
 * @param absolutePath 输入路径。
 * @returns 归一化后的绝对路径。
 */
function toAbsolute(absolutePath: string): string {
  return resolve(normalizePath(absolutePath, { trim: true, stripAtPrefix: true }));
}

/**
 * 判断路径是否落在允许的工作区根目录之内（含根目录自身）。
 * 两侧都先做 realpath 规范化，避免软链把越界路径伪装成合法路径。
 *
 * @param absolutePath 待检查的路径。
 * @param root 允许的工作区根目录。
 * @returns 允许时 { ok: true }；越界时返回带英文原因的 { ok: false }。
 */
export function assertPathWithinRoot(absolutePath: string, root: string): PathPolicyVerdict {
  if (!absolutePath) {
    return { ok: false, reason: "Path is empty" };
  }
  if (!root) {
    return { ok: false, reason: "Workspace root is not configured" };
  }

  // 先解析末级软链（含悬空目标）：write 会顺着软链创建目标文件，
  // canonicalizePath 对不存在的目标只回溯祖先，必须在这里补上最后一跳。
  const finalLink = resolveFinalSymlinkTarget(toAbsolute(absolutePath));
  if (finalLink.path === null) {
    return { ok: false, reason: "Path contains a symlink loop or exceeds the maximum symlink depth" };
  }

  const targetPath = canonicalizePath(finalLink.path);
  const rootPath = canonicalizePath(toAbsolute(root));

  if (targetPath === rootPath) {
    return { ok: true };
  }

  const rootWithSep = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  if (targetPath.startsWith(rootWithSep)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Path is outside the allowed workspace root (" + targetPath + " is not under " + rootPath + ")",
  };
}

/**
 * 判断路径是否为敏感路径（密钥、环境文件、版本库元数据、依赖目录）。
 * 即便路径已经在允许的根目录内也应拒绝，避免 Agent 无意读取或覆盖密钥、污染依赖目录。
 * 判定前先 realpath：软链指向敏感文件时，basename 必须变成目标名才能命中（P0-4）。
 *
 * @param absolutePath 待检查的路径。
 * @returns 命中拒绝清单时为 true。
 */
export function isDeniedPath(absolutePath: string): boolean {
  if (!absolutePath) {
    return true;
  }

  // 必须与 assertPathWithinRoot 一样走 realpath：否则 `foo -> .env` 这类软链会以 basename
  // `foo` 通过敏感名判断，实际读取的却是被拒文件。canonicalizePath 同步解析，不改变本函数同步语义。
  // 末级软链额外单独解析：`foo -> .env`（.env 尚不存在）时 canonicalizePath 会退回 `foo`，
  // 只有 readlink 能拿到真实目标名。
  const finalLink = resolveFinalSymlinkTarget(toAbsolute(absolutePath));
  if (finalLink.path === null) {
    return true;
  }
  const targetPath = canonicalizePath(finalLink.path);
  const segments = targetPath.split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return true;
  }

  // 任意一层落在敏感目录内即拒绝：node_modules/x/package.json、a/.git/config、~/.ssh/id_rsa 等
  if (segments.some((segment) => DENIED_DIRECTORIES.has(segment))) {
    return true;
  }

  const fileName = basename(targetPath).toLowerCase();
  // .env 精确命中，或 .env. 前缀（.env.local / .env.production），不误伤 .environment / .envoy
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return true;
  }
  if (DENIED_KEY_FILENAMES.has(fileName)) {
    return true;
  }

  return DENIED_EXTENSIONS.has(extname(fileName));
}
