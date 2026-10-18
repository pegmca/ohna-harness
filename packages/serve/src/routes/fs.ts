/**
 * 本地只读文件系统端点：`GET /api/local/fs?path=&mode=list|read|tree&depth=`。
 *
 * 安全边界（04 Phase 3 / L1-6）：
 * - 复用 `@aiagent/coding` 的 `assertPathWithinRoot` / `isDeniedPath`，与 Agent 工具使用
 *   **同一套**工作区沙箱与敏感路径判断，避免「工具拒读、接口能读」的绕过面；
 * - 只注册 GET：POST / PUT / PATCH / DELETE 由 Fastify 默认 404 拒绝，
 *   本模块不 import 任何写工具（write / edit / bash），写操作只能走 Agent + 确认闸门；
 * - 符号链接不跟随：tree 的 type 直接标 symlink，避免通过链接递归到工作区外。
 */
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { assertPathWithinRoot, isDeniedPath } from "@aiagent/coding";
import type {
  ApiResult,
  LocalFsEntryDto,
  LocalFsListDto,
  LocalFsReadDto,
  LocalFsTreeDto
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, failure } from "../errors.js";
import type { RouteDeps } from "./types.js";

/** list 模式最多返回的条目数。 */
const LIST_ENTRY_LIMIT = 1_000;

/** read 模式最多读取的字节数（256KB）。 */
const READ_MAX_BYTES = 256 * 1024;

/** 二进制嗅探窗口：只看开头 8KB，避免大文件全量扫描。 */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** tree 模式总条目上限。 */
const TREE_ENTRY_LIMIT = 2_000;

/** tree 默认深度与上限。 */
const TREE_DEFAULT_DEPTH = 2;
const TREE_MAX_DEPTH = 4;

/** tree 递归时总是跳过的重目录（即使未被 denylist 命中）。 */
const TREE_SKIP_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** 查询参数。 */
interface FsQuery {
  path?: string;
  mode?: string;
  depth?: string;
}

/**
 * 把绝对路径转成工作区相对路径（POSIX 分隔符，根为 "."）。
 *
 * @param root 工作区根。
 * @param absolute 绝对路径。
 * @returns 相对路径。
 */
function toRelativePath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (relative === "") return ".";
  return relative.split(path.sep).join("/");
}

/**
 * 把 fs 类型映射为线协议类型。
 *
 * @param stats lstat 结果。
 * @returns 条目类型。
 */
function entryTypeOf(stats: Stats): LocalFsEntryDto["type"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/**
 * lstat，不存在时返回 null（区分「不存在」与「无权限」由上层决定）。
 *
 * @param absolute 绝对路径。
 * @returns lstat 结果或 null。
 */
async function lstatOrNull(absolute: string): Promise<Stats | null> {
  try {
    return await fs.lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * 校验请求路径：必须落在工作区内且不属于敏感路径。
 *
 * @param root 工作区根。
 * @param rawPath 用户传入的相对路径。
 * @returns 解析后的绝对路径，或拒绝原因。
 */
function resolveSafePath(
  root: string,
  rawPath: string
): { ok: true; absolute: string; relative: string } | { ok: false; reason: "forbidden" | "invalid" } {
  const trimmed = rawPath.trim();
  if (trimmed.includes("\u0000")) return { ok: false, reason: "invalid" };

  const absolute = path.resolve(root, trimmed === "" ? "." : trimmed);
  if (!assertPathWithinRoot(absolute, root).ok) return { ok: false, reason: "forbidden" };
  if (isDeniedPath(absolute)) return { ok: false, reason: "forbidden" };

  return { ok: true, absolute, relative: toRelativePath(root, absolute) };
}

/**
 * list 模式：列目录并跳过不可读 / 敏感条目。
 *
 * @param absolute 绝对路径。
 * @param relative 工作区相对路径。
 * @returns 目录列表 DTO。
 */
async function listDirectory(absolute: string, relative: string): Promise<LocalFsListDto> {
  const stats = await fs.stat(absolute);
  if (!stats.isDirectory()) {
    throw Object.assign(new Error("路径不是目录。"), { code: "not_a_directory" });
  }

  const dirents = await fs.readdir(absolute, { withFileTypes: true });
  const sorted = [...dirents].sort((left, right) =>
    left.name.toLowerCase().localeCompare(right.name.toLowerCase())
  );

  const entries: LocalFsEntryDto[] = [];
  let truncated = false;
  for (const dirent of sorted) {
    if (entries.length >= LIST_ENTRY_LIMIT) {
      truncated = true;
      break;
    }
    const childAbsolute = path.join(absolute, dirent.name);
    // 敏感路径（.env / 私钥 / node_modules 等）不进入列表，避免 UI 引导用户去点。
    if (isDeniedPath(childAbsolute)) continue;

    try {
      const childStats = await fs.lstat(childAbsolute);
      const type = entryTypeOf(childStats);
      entries.push({
        name: dirent.name,
        path: relative === "." ? dirent.name : `${relative}/${dirent.name}`,
        type,
        ...(type === "file" ? { size: childStats.size } : {})
      });
    } catch {
      // 单项无权限 / 竞态删除：跳过而非让整个列表失败。
    }
  }

  return { path: relative, entries, ...(truncated ? { truncated } : {}) };
}

/**
 * read 模式：只读文本，二进制与超限都结构化返回。
 *
 * @param absolute 绝对路径。
 * @param relative 工作区相对路径。
 * @returns 读取结果 DTO。
 */
async function readFile(absolute: string, relative: string): Promise<LocalFsReadDto> {
  const stats = await fs.stat(absolute);
  if (!stats.isFile()) {
    throw Object.assign(new Error("路径不是文件。"), { code: "not_a_file" });
  }

  const length = Math.min(stats.size, READ_MAX_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = await fs.open(absolute, "r");
  let bytesRead = 0;
  try {
    if (length > 0) {
      const result = await handle.read(buffer, 0, length, 0);
      bytesRead = result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  const head = buffer.subarray(0, Math.min(bytesRead, BINARY_SNIFF_BYTES));
  const binary = head.includes(0);
  return {
    path: relative,
    content: binary ? "" : buffer.subarray(0, bytesRead).toString("utf8"),
    bytes: stats.size,
    truncated: stats.size > READ_MAX_BYTES,
    binary
  };
}

/**
 * tree 模式的递归计数器（跨分支共享，保证总量上限）。 
 */
interface TreeBudget {
  count: number;
  exhausted: boolean;
}

/**
 * 递归构建文件树节点。
 *
 * @param absolute 当前绝对路径。
 * @param relative 当前工作区相对路径。
 * @param depth 剩余可递归层数。
 * @param budget 全局条目预算。
 * @returns 树节点。
 */
async function buildTreeNode(
  absolute: string,
  relative: string,
  depth: number,
  budget: TreeBudget
): Promise<LocalFsTreeDto> {
  const stats = await fs.lstat(absolute);
  const type = entryTypeOf(stats);
  const node: LocalFsTreeDto = { path: relative, type };
  if (type !== "directory") return node;

  if (depth <= 0) {
    // 到达深度上限：不再展开，但保留节点本身（深度是预期裁剪，不算 truncated）。
    return node;
  }

  const names = (await fs.readdir(absolute)).slice().sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase())
  );

  const children: LocalFsTreeDto[] = [];
  for (const name of names) {
    if (TREE_SKIP_NAMES.has(name)) continue;
    const childAbsolute = path.join(absolute, name);
    if (isDeniedPath(childAbsolute)) continue;
    if (budget.exhausted || budget.count >= TREE_ENTRY_LIMIT) {
      budget.exhausted = true;
      node.truncated = true;
      break;
    }

    budget.count += 1;
    try {
      const childStats = await fs.lstat(childAbsolute);
      const childRelative = relative === "." ? name : `${relative}/${name}`;
      if (entryTypeOf(childStats) === "directory") {
        children.push(await buildTreeNode(childAbsolute, childRelative, depth - 1, budget));
      } else {
        children.push({ path: childRelative, type: entryTypeOf(childStats) });
      }
    } catch {
      // 递归中单项失败（权限 / 竞态）跳过。
    }
  }

  if (children.length > 0) node.children = children;
  return node;
}

/**
 * 注册只读 fs 路由。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerFsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Querystring: FsQuery }>(
    "/api/local/fs",
    async (request, reply): Promise<ApiResult<LocalFsListDto | LocalFsReadDto | LocalFsTreeDto>> => {
      const requestId = createRequestId();
      const rawPath = request.query.path ?? ".";
      if (typeof rawPath !== "string") {
        return failure(reply, requestId, 400, "validation_failed", "path 必须是字符串。");
      }

      const mode = request.query.mode ?? "list";
      if (mode !== "list" && mode !== "read" && mode !== "tree") {
        return failure(reply, requestId, 400, "validation_failed", "mode 必须是 list、read 或 tree。");
      }

      let depth = TREE_DEFAULT_DEPTH;
      if (request.query.depth !== undefined) {
        const parsed = Number(request.query.depth);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > TREE_MAX_DEPTH) {
          return failure(
            reply,
            requestId,
            400,
            "validation_failed",
            `depth 必须是 1-${TREE_MAX_DEPTH} 的整数。`
          );
        }
        depth = parsed;
      }

      const safe = resolveSafePath(deps.workspaceRoot, rawPath);
      if (!safe.ok) {
        return safe.reason === "forbidden"
          ? failure(reply, requestId, 403, "forbidden", "路径越界或命中敏感路径，已拒绝访问。")
          : failure(reply, requestId, 400, "validation_failed", "path 格式不正确。");
      }

      let stats: Stats | null;
      try {
        stats = await lstatOrNull(safe.absolute);
      } catch {
        return failure(reply, requestId, 403, "forbidden", "无法读取该路径。");
      }
      if (!stats) {
        return failure(reply, requestId, 404, "not_found", "路径不存在。");
      }

      try {
        if (mode === "read") {
          return { ok: true, requestId, data: await readFile(safe.absolute, safe.relative) };
        }
        if (mode === "tree") {
          const budget: TreeBudget = { count: 0, exhausted: false };
          return {
            ok: true,
            requestId,
            data: await buildTreeNode(safe.absolute, safe.relative, depth, budget)
          };
        }
        return { ok: true, requestId, data: await listDirectory(safe.absolute, safe.relative) };
      } catch (error) {
        if ((error as { code?: string }).code === "not_a_directory") {
          return failure(reply, requestId, 400, "bad_request", "路径不是目录。");
        }
        if ((error as { code?: string }).code === "not_a_file") {
          return failure(reply, requestId, 400, "bad_request", "路径不是文件。");
        }
        return failure(reply, requestId, 403, "forbidden", "无法读取该路径。");
      }
    }
  );
}
