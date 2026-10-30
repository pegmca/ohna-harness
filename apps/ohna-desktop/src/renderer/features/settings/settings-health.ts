/** 设置页数据探针：直接读取 utilityProcess 内 runtime 的健康事实，不再假设存在 HTTP 服务。 */
import { useEffect, useState } from "react";
import { getRuntimeHealth } from "../../shared/sdk/ohna-client";

/** runtime 的本地连接事实。 */
export interface SettingsHealth {
  protocolVersion: number;
  modelCount: number;
  workspaceCount: number;
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
  void signal;
  try {
    const result = await getRuntimeHealth();
    if (!result.ok) return { state: "unavailable", health: undefined };
    return {
      state: "ready",
      health: {
        protocolVersion: result.data.protocolVersion,
        modelCount: result.data.modelCount,
        workspaceCount: result.data.workspaceCount
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
