/**
 * 「模型」分区：编辑用户级 `~/.ohna/settings.json`。
 *
 * 配置的唯一事实源是用户目录下的 settings 文件；仓库 `.env` 不再参与桌面运行配置。
 * 模型下拉选项来自 provider 的 `/v1/models` 拉取结果（写入 settings.providers[].models）。
 */
import { useEffect, useState } from "react";
import {
  fetchProviderModels,
  loadUserSettings,
  saveUserSettings,
  type UserSettings
} from "../../shared/sdk/ohna-client";
import { SettingsSection } from "./settings-primitives";

/** 表单状态：加载 / 可编辑 / 保存中 / 已保存。 */
type FormState =
  | { state: "loading" }
  | { state: "ready"; settings: UserSettings; savedAt?: string }
  | { state: "failed"; message: string };

/**
 * 从 provider 配置生成完整 settings（保留未编辑的其它 profile）。
 *
 * @param settings 原 settings。
 * @param profile 当前 profile。
 * @param patch 待更新字段。
 * @returns 新 settings。
 */
function patchProvider(
  settings: UserSettings,
  profile: string,
  patch: Partial<UserSettings["providers"][string]>
): UserSettings {
  const current = settings.providers[profile] ?? {
    baseUrl: "",
    model: "",
    models: [],
    apiKey: ""
  };
  return {
    ...settings,
    providers: {
      ...settings.providers,
      [profile]: { ...current, ...patch }
    }
  };
}

/**
 * 编辑某个 provider 的模型分组。
 *
 * @param settings 原 settings。
 * @param profile provider 名。
 * @param groups 新分组。
 * @returns 新 settings。
 */
function patchGroups(
  settings: UserSettings,
  profile: string,
  groups: NonNullable<UserSettings["providers"][string]["groups"]>
): UserSettings {
  return patchProvider(settings, profile, { groups });
}

/**
 * 从扁平的已拉取模型中生成初始分组（按现有 groups 优先）。
 *
 * @param provider provider 配置。
 * @returns 分组列表。
 */
function effectiveGroups(
  provider: UserSettings["providers"][string]
): NonNullable<UserSettings["providers"][string]["groups"]> {
  if (provider.groups?.length) return provider.groups;
  return [{ name: "默认组", models: provider.models?.length ? provider.models : [provider.model].filter(Boolean) }];
}

/**
 * 渲染可编辑模型配置。
 *
 * @returns 模型配置表单。
 */
export function ModelsSection() {
  const [form, setForm] = useState<FormState>({ state: "loading" });
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void Promise.resolve(loadUserSettings())
      .then((result) => {
        if (!result) {
          setForm({ state: "failed", message: "用户配置读取失败。" });
          return;
        }
        setForm(result.ok
          ? { state: "ready", settings: result.data }
          : { state: "failed", message: result.error.message });
      })
      .catch((error: unknown) => {
        setForm({
          state: "failed",
          message: error instanceof Error ? error.message : "用户配置读取失败。"
        });
      });
  }, []);

  /**
   * 保存配置到 main（原子写 + 0600）。
   *
   * @returns 无返回值。
   */
  async function handleSave(): Promise<void> {
    if (form.state !== "ready") return;
    setSaving(true);
    setError(undefined);
    const result = await saveUserSettings(form.settings);
    setSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setForm({
      state: "ready",
      settings: form.settings,
      savedAt: new Date().toLocaleTimeString()
    });
  }

  /**
   * 从 provider `/v1/models` 拉取模型列表并回填表单。
   *
   * @returns 无返回值。
   */
  async function handleFetchModels(): Promise<void> {
    if (form.state !== "ready") return;
    const profile = form.settings.defaultProfile;
    const provider = form.settings.providers[profile];
    if (!provider?.baseUrl || !provider.apiKey) {
      setError("请先填写 Base URL 与 API Key。");
      return;
    }
    setFetchingModels(true);
    setError(undefined);
    const result = await fetchProviderModels({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      ...(form.settings.httpProxy ? { httpProxy: form.settings.httpProxy } : {})
    });
    setFetchingModels(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const models = result.data;
    // 拉取结果合并进分组：已有分组只追加缺失模型，未分组时生成「默认组」。
    const groups = effectiveGroups(provider);
    const known = new Set(groups.flatMap((group) => group.models));
    const missing = models.filter((id) => !known.has(id));
    const mergedGroups = missing.length > 0
      ? groups.map((group, index) =>
          index === 0 ? { ...group, models: [...group.models, ...missing] } : group
        )
      : groups;
    setForm({
      ...form,
      settings: patchProvider(form.settings, profile, {
        models,
        groups: mergedGroups,
        model: models.includes(provider.model) ? provider.model : models[0] ?? provider.model
      })
    });
  }

  if (form.state === "loading") {
    return (
      <SettingsSection description="正在读取用户配置。" id="models" title="模型">
        <p className="muted-row">正在读取 ~/.ohna/settings.json…</p>
      </SettingsSection>
    );
  }
  if (form.state === "failed") {
    return (
      <SettingsSection description="用户配置读取失败。" id="models" title="模型">
        <p className="error-block">{form.message}</p>
      </SettingsSection>
    );
  }

  const settings = form.settings;
  const profile = settings.defaultProfile;
  const provider = settings.providers[profile] ?? {
    baseUrl: "",
    model: "",
    models: [],
    apiKey: ""
  };
  const models = provider.models ?? [];

  return (
    <SettingsSection
      description="配置保存在 ~/.ohna/settings.json（明文密钥，文件权限 0600）；保存后重启 ohna 生效。"
      id="models"
      title="模型"
    >
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        <label className="settings-field">
          <span>Provider</span>
          <input
            onChange={(event) => setForm({
              ...form,
              settings: { ...settings, defaultProfile: event.target.value }
            })}
            placeholder="bridge_ai"
            value={profile}
          />
        </label>

        <label className="settings-field">
          <span>Base URL</span>
          <input
            onChange={(event) => setForm({
              ...form,
              settings: patchProvider(settings, profile, { baseUrl: event.target.value })
            })}
            placeholder="http://host:8787/v1"
            value={provider.baseUrl}
          />
        </label>

        <div className="settings-field">
          <span>模型分组</span>
          <p className="settings-helper">每组可包含多个模型；组内选中的模型是该组默认，可在 composer 中切换。</p>
          <div className="model-group-editor">
            {effectiveGroups(provider).map((group, groupIndex) => (
              <div className="model-group-card" key={`${group.name}-${groupIndex}`}>
                <input
                  aria-label={`第 ${groupIndex + 1} 组名称`}
                  onChange={(event) => {
                    const next = effectiveGroups(provider).map((item, index) =>
                      index === groupIndex ? { ...item, name: event.target.value } : item
                    );
                    setForm({ ...form, settings: patchGroups(settings, profile, next) });
                  }}
                  value={group.name}
                />
                <div className="model-chip-list">
                  {group.models.map((id) => (
                    <button
                      aria-pressed={provider.model === id}
                      className={`model-chip ${provider.model === id ? "is-default" : ""}`}
                      key={id}
                      onClick={() => setForm({
                        ...form,
                        settings: patchProvider(settings, profile, { model: id })
                      })}
                      title={provider.model === id ? "当前默认模型" : "设为默认模型"}
                      type="button"
                    >
                      {id}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <button
          className="md-button-secondary"
          disabled={fetchingModels}
          onClick={() => void handleFetchModels()}
          type="button"
        >
          {fetchingModels ? "拉取中…" : "从 /v1/models 拉取模型"}
        </button>

        <label className="settings-field">
          <span>默认模型</span>
          <select
            onChange={(event) => setForm({
              ...form,
              settings: patchProvider(settings, profile, { model: event.target.value })
            })}
            value={provider.model}
          >
            {models.length === 0 ? <option value={provider.model}>{provider.model || "未配置"}</option> : null}
            {models.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>

        <label className="settings-field">
          <span>API Key</span>
          <input
            autoComplete="off"
            onChange={(event) => setForm({
              ...form,
              settings: patchProvider(settings, profile, { apiKey: event.target.value })
            })}
            type="password"
            value={provider.apiKey}
          />
        </label>

        <label className="settings-field">
          <span>HTTP 代理</span>
          <input
            onChange={(event) => setForm({
              ...form,
              settings: { ...settings, httpProxy: event.target.value }
            })}
            placeholder="http://127.0.0.1:1082"
            value={settings.httpProxy ?? ""}
          />
        </label>

        {error ? <p className="error-block" role="status">{error}</p> : null}
        {form.savedAt ? <p className="settings-helper" role="status">已保存（{form.savedAt}），重启 ohna 后生效。</p> : null}
        <button className="md-button-primary" disabled={saving} type="submit">
          {saving ? "保存中…" : "保存配置"}
        </button>
      </form>
    </SettingsSection>
  );
}
