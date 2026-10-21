/**
 * 「模型」分区（03 L3-3）：只读展示当前进程的模型目录。
 *
 * 复用 composer 的 `/api/models` 端点；模型由启动 ohna 时的 CLI 参数决定，web 不提供切换，
 * 因此刻意没有任何可写控件（D4：不新增写配置端点）。
 */
import type { ModelCatalogDto } from "@aiagent/types";
import { useEffect, useState } from "react";
import { listModels } from "../../shared/api/composer-client";
import { SettingsBadge, SettingsSection } from "./settings-primitives";

/** 模型目录探针状态。 */
type CatalogState =
  | { state: "loading" }
  | { state: "ready"; catalog: ModelCatalogDto }
  | { state: "failed"; message: string };

/**
 * 渲染模型分区。
 *
 * @returns 模型只读列表。
 */
export function ModelsSection() {
  const [catalog, setCatalog] = useState<CatalogState>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await listModels(controller.signal);
        if (controller.signal.aborted) return;
        setCatalog(result.ok
          ? { state: "ready", catalog: result.data }
          : { state: "failed", message: result.error.message });
      } catch {
        if (!controller.signal.aborted) setCatalog({ state: "failed", message: "模型目录加载失败，请确认本地服务仍在运行。" });
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <SettingsSection
      description="模型由启动 ohna 时的 CLI 参数决定，此处只读展示，不支持在 Web 中切换。"
      id="models"
      title="模型"
    >
      {catalog.state === "loading" ? <p className="muted-row">正在读取模型目录…</p> : null}
      {catalog.state === "failed" ? <p className="error-block">{catalog.message}</p> : null}
      {catalog.state === "ready" ? (
        <ul className="settings-model-list">
          {catalog.catalog.models.map((model) => (
            <li className="settings-model-row" key={model.id}>
              <div className="settings-model-title">
                <strong>{model.label}</strong>
                {model.id === catalog.catalog.defaultModelId ? <SettingsBadge tone="info">默认</SettingsBadge> : null}
              </div>
              <p className="settings-helper">{model.description}</p>
              <div className="settings-model-badges">
                <SettingsBadge tone="neutral">{model.provider}</SettingsBadge>
                <SettingsBadge tone="neutral"><code>{model.id}</code></SettingsBadge>
                {model.capabilities.toolCalling ? <SettingsBadge tone="success">tool calling</SettingsBadge> : null}
                {model.capabilities.structuredOutput ? <SettingsBadge tone="success">structured output</SettingsBadge> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsSection>
  );
}
