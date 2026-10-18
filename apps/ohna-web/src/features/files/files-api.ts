/**
 * 只读文件树 API（W-2）：`GET /api/local/fs?path=&mode=list|read|tree&depth=`。
 * path 一律是工作区相对路径（根 "."）；越界 / 敏感路径由服务端 403 拒绝。
 */
import type { ApiResult, LocalFsListDto, LocalFsReadDto, LocalFsTreeDto } from "@aiagent/types";
import { parseApiResult } from "../../shared/api/http-client";

/**
 * 列出目录一层条目。
 *
 * @param path 工作区相对路径（根 "."）。
 * @param signal 取消信号。
 * @returns 目录列表 DTO。
 */
export async function listFs(path: string, signal?: AbortSignal): Promise<ApiResult<LocalFsListDto>> {
  const query = new URLSearchParams({ path, mode: "list" });
  return parseApiResult(await fetch(`/api/local/fs?${query}`, { signal }));
}

/**
 * 读取单个文本文件（只读预览；二进制返回 binary:true 且 content 为空）。
 *
 * @param path 工作区相对路径。
 * @param signal 取消信号。
 * @returns 读取结果 DTO。
 */
export async function readFs(path: string, signal?: AbortSignal): Promise<ApiResult<LocalFsReadDto>> {
  const query = new URLSearchParams({ path, mode: "read" });
  return parseApiResult(await fetch(`/api/local/fs?${query}`, { signal }));
}

/**
 * 递归展开目录树（受服务端深度 / 总量上限约束）。
 *
 * @param path 工作区相对路径。
 * @param depth 递归深度（1-4，服务端默认 2）。
 * @param signal 取消信号。
 * @returns 树节点 DTO。
 */
export async function treeFs(
  path: string,
  depth: number,
  signal?: AbortSignal
): Promise<ApiResult<LocalFsTreeDto>> {
  const query = new URLSearchParams({ path, mode: "tree", depth: String(depth) });
  return parseApiResult(await fetch(`/api/local/fs?${query}`, { signal }));
}
