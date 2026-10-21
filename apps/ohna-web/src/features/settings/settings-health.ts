/**
 * 设置页数据探针：`GET /api/health` 的完整扁平形状（比 `shared/mode.ts` 多出 pid 等诊断字段）。
 *
 * 为什么单独一份而不是给 `LocalModeInfo` 加字段：chat 头部只关心工作目录，设置页需要
 * 「连接状态」的诊断信息；两者用途不同，避免把设置页字段泄漏到会话页。
 * 只读：这里不发任何写请求。
 */
import { useEffect, useState } from "react";

/** `/api/health` 的本地连接事实。 */
export interface SettingsHealth {
  /** serve 端口（浏览器 `location.port`；本地服务即当前页面来源）。 */
  port: string;
  /** 当前页面来源（serve URL）。 */
  url: string;
  workspaceRoot: string;
  dataDir: string | undefined;
  modelId: string | undefined;
  modelProvider: string | undefined;
  pid: number | undefined;
}

/** health 原始 payload（packages/serve/src/routes/health.ts）。 */
interface RawHealth {
  mode?: string;
  workspaceRoot?: string;
  model?: { id?: string; provider?: string };
  pid?: number;
  dataDir?: string;
}

/** 探针状态：loading → ready / unavailable。 */
export interface SettingsHealthState {
  state: "loading" | "ready" | "unavailable";
  health: SettingsHealth | undefined;
}

/**
 * 拉取本地健康信息（只读）。
 *
 * @param signal 取消信号。
 * @returns 设置页需要的连接事实；非 local / 失败返回 unavailable。
 */
export async function fetchSettingsHealth(signal?: AbortSignal): Promise<SettingsHealthState> {
  try {
    const response = await fetch("/api/health", { signal });
    if (!response.ok) return { state: "unavailable", health: undefined };
    const payload = (await response.json()) as RawHealth;
    if (payload.mode !== "local" || typeof payload.workspaceRoot !== "string") {
      return { state: "unavailable", health: undefined };
    }
    return {
      state: "ready",
      health: {
        port: window.location.port || "80",
        url: window.location.origin,
        workspaceRoot: payload.workspaceRoot,
        dataDir: typeof payload.dataDir === "string" ? payload.dataDir : undefined,
        modelId: payload.model?.id,
        modelProvider: payload.model?.provider,
        pid: typeof payload.pid === "number" ? payload.pid : undefined
      }
    };
  } catch {
    return { state: "unavailable", health: undefined };
  }
}

/**
 * 订阅本地健康信息（挂载时拉取一次）。
 *
 * @returns 探针状态。
 */
export function useSettingsHealth(): SettingsHealthState {
  const [state, setState] = useState<SettingsHealthState>({ state: "loading", health: undefined });
  useEffect(() => {
    const controller = new AbortController();
    void fetchSettingsHealth(controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, []);
  return state;
}
