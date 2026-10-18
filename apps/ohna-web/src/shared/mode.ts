/**
 * 本地运行模式探针（W-7）：`GET /api/health` 返回扁平对象（非 ApiResult），
 * ohna-web 用 `mode:"local"` 判断「当前是本地编码 Agent」，
 * 并展示工作目录；非 local / 请求失败一律降级为 null（隐藏本地标识即可，不白屏）。
 */

/** 本地模式信息（从 /api/health 收窄）。 */
export interface LocalModeInfo {
  /** Agent 的工作区根目录（编码工具与文件树的作用域）。 */
  workspaceRoot: string;
  /** 当前模型 id（单模型目录）。 */
  modelId?: string;
  /** JSONL 数据目录。 */
  dataDir?: string;
}

/** /api/health 的原始形状（packages/serve/routes/health.ts）。 */
interface LocalHealthPayload {
  mode?: string;
  workspaceRoot?: string;
  model?: { id?: string };
  dataDir?: string;
}

/**
 * 拉取本地运行模式；非 local 或任何失败都返回 null。
 *
 * @param signal 取消信号。
 * @returns 本地模式信息；非本地环境返回 null。
 */
export async function fetchLocalMode(signal?: AbortSignal): Promise<LocalModeInfo | null> {
  try {
    const response = await fetch("/api/health", { signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as LocalHealthPayload;
    if (payload.mode !== "local" || typeof payload.workspaceRoot !== "string") return null;
    return {
      workspaceRoot: payload.workspaceRoot,
      ...(typeof payload.model?.id === "string" ? { modelId: payload.model.id } : {}),
      ...(typeof payload.dataDir === "string" ? { dataDir: payload.dataDir } : {})
    };
  } catch {
    // 本地服务未启动 / 代理断连：按「非本地」降级，由调用方决定展示。
    return null;
  }
}
