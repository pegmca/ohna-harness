/**
 * 用户级配置存储：`<dataDir>/settings.json`（默认 `~/.ohna/settings.json`）。
 *
 * 为什么放在 dataDir 而非仓库 `.env`：桌面配置属于用户与机器，不应随项目切换；
 * 同一份形状同时服务 UI 编辑、runtime 启动与自动化测试（测试以 `OHNA_SETTINGS_PATH`
 * 指向临时文件，不依赖散落的环境变量）。文件含明文 API key，写入时强制 0600。
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@aiagent/ai";

/** 单个 OpenAI 兼容 provider 配置。 */
export interface ProviderSettings {
  /** OpenAI 兼容 baseUrl，例如 `http://host:8787/v1`。 */
  baseUrl: string;
  /** 当前选中的模型 id。 */
  model: string;
  /** 该 provider `/v1/models` 拉取到的可用模型 id 列表。 */
  models?: string[];
  /**
   * 分组目录（对齐 Codex 的 provider 分组）：每组可包含多个模型，组内首个即该组默认模型。
   * 省略时按 `models` 视为单组；保留该字段以兼容已有 settings。
   */
  groups?: ModelGroup[];
  /** 明文 API key（文件权限 0600）。 */
  apiKey: string;
}

/** 同一 provider 下的一组模型（组内首个为默认模型）。 */
export interface ModelGroup {
  /** 组名，例如「主力模型」「快速模型」「视觉模型」。 */
  name: string;
  /** 组内模型 id，顺序即优先级。 */
  models: string[];
}

/** 用户级 settings.json 形状。 */
export interface OhnaSettings {
  /** 默认 provider profile 名（对应 providers 的键）。 */
  defaultProfile: string;
  /** provider profile → 配置。 */
  providers: Record<string, ProviderSettings>;
  /** 可选 HTTP 代理；Node fetch 不读系统代理，远端 provider 在 TUN 环境下需要此项。 */
  httpProxy?: string;
}

/** 缺省 settings（无 provider 时 runtime 进入 degraded）。 */
const EMPTY_SETTINGS: OhnaSettings = { defaultProfile: "", providers: {} };

/**
 * 解析模型分组：丢弃无名/空组，组内模型 id 去重并保留顺序。
 *
 * @param value 原始 groups 字段。
 * @returns 合法分组。
 */
function parseGroups(value: unknown[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string" || item.name.trim() === "") continue;
    if (!Array.isArray(item.models)) continue;
    const models = [...new Set(
      item.models.filter((id): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim())
    )];
    if (models.length === 0) continue;
    groups.push({ name: item.name.trim(), models });
  }
  return groups;
}

/**
 * 解析 settings.json 路径。
 *
 * 优先 `OHNA_SETTINGS_PATH`（测试/自动化），否则 `<dataDir>/settings.json`。
 *
 * @param dataDir 数据目录。
 * @param env 环境变量表。
 * @returns 绝对路径。
 */
export function resolveSettingsPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OHNA_SETTINGS_PATH?.trim();
  return override ? path.resolve(override) : path.join(dataDir, "settings.json");
}

/**
 * 把未知 JSON 收窄为合法 settings；非法字段丢弃而不是阻断启动。
 *
 * @param value 已解析 JSON。
 * @returns 合法 settings。
 */
function parseSettings(value: unknown): OhnaSettings {
  if (!value || typeof value !== "object") return { ...EMPTY_SETTINGS };
  const record = value as Record<string, unknown>;
  const providers: Record<string, ProviderSettings> = {};
  const rawProviders = record.providers;
  if (rawProviders && typeof rawProviders === "object") {
    for (const [profile, entry] of Object.entries(rawProviders as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (
        typeof item.baseUrl !== "string"
        || typeof item.model !== "string"
        || typeof item.apiKey !== "string"
      ) continue;
      providers[profile] = {
        baseUrl: item.baseUrl.trim(),
        model: item.model.trim(),
        ...(Array.isArray(item.models)
          ? { models: item.models.filter((id): id is string => typeof id === "string" && id.trim() !== "") }
          : {}),
        ...(Array.isArray(item.groups)
          ? { groups: parseGroups(item.groups) }
          : {}),
        apiKey: item.apiKey
      };
    }
  }
  const profiles = Object.keys(providers);
  const preferred =
    typeof record.defaultProfile === "string" && providers[record.defaultProfile]
      ? record.defaultProfile
      : profiles[0] ?? "";
  return {
    defaultProfile: preferred,
    providers,
    ...(typeof record.httpProxy === "string" && record.httpProxy.trim()
      ? { httpProxy: record.httpProxy.trim() }
      : {})
  };
}

/**
 * 读取用户 settings；文件不存在返回空配置。
 *
 * @param dataDir 数据目录。
 * @param env 环境变量表。
 * @returns settings 与文件路径。
 */
export async function readSettings(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ settings: OhnaSettings; path: string }> {
  const settingsPath = resolveSettingsPath(dataDir, env);
  try {
    const raw = await readFile(settingsPath, "utf8");
    return { settings: parseSettings(JSON.parse(raw)), path: settingsPath };
  } catch {
    return { settings: { ...EMPTY_SETTINGS }, path: settingsPath };
  }
}

/**
 * 原子写入 settings，并强制文件权限 0600。
 *
 * @param dataDir 数据目录。
 * @param settings 待保存配置。
 * @param env 环境变量表。
 * @returns 写入后的绝对路径。
 */
export async function writeSettings(
  dataDir: string,
  settings: OhnaSettings,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const settingsPath = resolveSettingsPath(dataDir, env);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(parseSettings(settings), null, 2)}\n`;
  await writeFile(tempPath, payload, { mode: 0o600 });
  await rename(tempPath, settingsPath);
  await chmod(settingsPath, 0o600);
  return settingsPath;
}

/**
 * 把 settings 中的默认 provider 构造成 runtime 可用的模型与凭据。
 *
 * @param settings 用户配置。
 * @returns 模型、apiKey 与 profile；无可用配置返回 null。
 */
export function resolveModelFromSettings(
  settings: OhnaSettings,
  modelId?: string
): { model: Model<"openai-completions">; apiKey: string; profile: string } | null {
  const profile = settings.defaultProfile;
  const provider = settings.providers[profile];
  const selected = modelId?.trim() || provider?.model;
  if (!profile || !provider || !provider.baseUrl || !selected || !provider.apiKey) return null;
  return {
    profile,
    apiKey: provider.apiKey,
    model: {
      id: selected,
      name: selected,
      api: "openai-completions",
      provider: profile,
      baseUrl: provider.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192
    }
  };
}

/**
 * 由 settings 构造模型目录（含分组），供设置页与 composer 的多模型选择使用。
 *
 * 分组来源：`provider.groups` 优先；缺省把 `provider.models` 视为单组；
 * 都没有时只包含当前 `provider.model`。因此旧 settings 仍然可用。
 *
 * @param settings 用户配置。
 * @returns 模型目录；无有效 provider 返回 null。
 */
export function buildModelCatalogFromSettings(settings: OhnaSettings): {
  defaultModelId: string;
  models: Array<{
    id: string;
    group?: string;
    isDefault: boolean;
  }>;
} | null {
  const profile = settings.defaultProfile;
  const provider = settings.providers[profile];
  if (!profile || !provider) return null;

  const groups = provider.groups?.length
    ? provider.groups
    : [{
        name: "",
        models: provider.models?.length ? provider.models : [provider.model]
      }];
  const seen = new Set<string>();
  const models: Array<{ id: string; group?: string; isDefault: boolean }> = [];
  for (const group of groups) {
    for (const id of group.models) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        ...(group.name ? { group: group.name } : {}),
        isDefault: id === provider.model
      });
    }
  }
  if (models.length === 0) return null;
  // 若配置的默认模型不在列表中，回退到第一个模型，保证 composer 有可选项。
  const defaultModelId = models.some((model) => model.id === provider.model)
    ? provider.model
    : models[0].id;
  for (const model of models) model.isDefault = model.id === defaultModelId;
  return { defaultModelId, models };
}
