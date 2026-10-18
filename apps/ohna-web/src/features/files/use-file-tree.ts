/**
 * 文件树数据 hook：懒加载目录、联动刷新与错误收敛全部收在这里，
 * FileTreePanel 只保留展示编排。
 *
 * - 懒加载：初始只 list 根目录一层，展开目录时才 list 子目录；
 * - 联动刷新（W-8）：调用方订阅 refresh-bus 后触发 `refresh`，
 *   重新拉取所有已展开目录，保留展开态；
 * - 请求代次：切换 / 刷新时丢弃迟到响应，避免旧数据串写。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalFsEntryDto } from "@aiagent/types";
import { listFs } from "./files-api";
// 类型单向引用视图文件（纯 import type，无运行时边）。
import type { EntriesByDir, ExpandedDirs } from "./file-tree-views";

/**
 * 管理文件树加载状态。
 *
 * @returns 目录缓存、展开态、错误与操作。
 */
export function useFileTree(): {
  entriesByDir: EntriesByDir;
  expanded: ExpandedDirs;
  error: string | undefined;
  toggleDir(path: string): void;
  refresh(): Promise<void>;
  /** 合并高频联动刷新的入口（refresh-bus 订阅回调使用）。 */
  scheduleRefresh(): Promise<void>;
} {
  const [entriesByDir, setEntriesByDir] = useState<EntriesByDir>({});
  const [expanded, setExpanded] = useState<ExpandedDirs>(() => new Set(["."]));
  const [error, setError] = useState<string>();
  const generationRef = useRef(0);
  const refreshPendingRef = useRef(false);
  const refreshRunningRef = useRef(false);
  // 异步回调里需要读到最新展开态 / 缓存；在 effect 中镜像（渲染期写 ref 会被 react-hooks 拦截）。
  const expandedRef = useRef(expanded);
  const entriesRef = useRef(entriesByDir);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  useEffect(() => {
    entriesRef.current = entriesByDir;
  }, [entriesByDir]);

  const refresh = useCallback(async (): Promise<void> => {
    refreshRunningRef.current = true;
    const generation = ++generationRef.current;
    const dirs = [...expandedRef.current];
    const results = await Promise.all(dirs.map((dir) => listFs(dir)));
    if (generation !== generationRef.current) {
      refreshRunningRef.current = false;
      return;
    }
    const merged: Record<string, LocalFsEntryDto[]> = { ...entriesRef.current };
    let firstError: string | undefined;
    dirs.forEach((dir, index) => {
      const result = results[index];
      if (result.ok) merged[dir] = result.data.entries;
      else firstError ??= result.error.message;
    });
    if (generation === generationRef.current) {
      setEntriesByDir(merged);
      setError(firstError);
    }
    refreshRunningRef.current = false;
  }, []);

  const scheduleRefresh = useCallback(async (): Promise<void> => {
    // 合并高频联动刷新：正在刷新时只置位 pending，结束后补一轮，避免请求风暴。
    if (refreshRunningRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    await refresh();
    if (refreshPendingRef.current) {
      refreshPendingRef.current = false;
      await refresh();
    }
  }, [refresh]);

  const loadDir = useCallback(async (path: string): Promise<void> => {
    const generation = generationRef.current;
    const result = await listFs(path);
    if (generation !== generationRef.current) return;
    if (result.ok) {
      setEntriesByDir((current) => ({ ...current, [path]: result.data.entries }));
      setError(undefined);
    } else {
      setError(result.error.message);
    }
  }, []);

  const toggleDir = useCallback((path: string): void => {
    const next = new Set(expandedRef.current);
    if (next.has(path)) {
      next.delete(path);
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    if (!entriesRef.current[path]) {
      void loadDir(path);
    }
  }, [loadDir]);

  return { entriesByDir, expanded, error, toggleDir, refresh, scheduleRefresh };
}
