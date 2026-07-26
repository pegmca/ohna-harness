import type { LlmClient, LlmResult } from "@aiagent/types";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_PROFILE, KIMI_CODE_MODEL, KIMI_CODE_OPENAI_BASE_URL } from "./config.js";
import { createLlmClient } from "../llm-client.js";

let projectEnvLoaded = false;

/**
 * 从环境变量创建 LLM client，用结构化错误表达缺失或非法配置。
 *
 * @param env 可注入的环境变量集合，默认读取当前进程环境。
 * @returns 成功时返回 LLM client，失败时返回配置错误。
 */
export function createLlmClientFromEnv(env: Record<string, string | undefined> = getDefaultEnv()): LlmResult<LlmClient> {
  loadProjectEnv();
  const mergedEnv = mergeProcessEnv(env);
  const profile = resolveProfile(mergedEnv);
  const rawConfig = resolveProfileConfig(mergedEnv, profile);
  const timeoutResult = parseTimeoutMs(mergedEnv.AIAGENT_LLM_TIMEOUT_MS);

  if (!timeoutResult.ok) {
    return timeoutResult;
  }

  if (!rawConfig.apiKey) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: `Missing LLM API key for ${profile}.`,
        details: { profile, supportedEnv: rawConfig.supportedApiKeyEnv }
      }
    };
  }

  if (!rawConfig.model) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: `Missing LLM model for ${profile}.`,
        details: { profile, supportedEnv: rawConfig.supportedModelEnv }
      }
    };
  }

  return {
    ok: true,
    data: createLlmClient({
      apiKey: rawConfig.apiKey,
      baseUrl: rawConfig.baseUrl,
      model: rawConfig.model,
      timeoutMs: timeoutResult.data
    })
  };
}

/**
 * 合并已加载的进程环境和调用方显式传入的环境，让脚本临时覆盖不会丢失 .env 配置。
 *
 * @param env 调用方显式传入的环境变量集合。
 * @returns 合并后的环境变量集合，显式传入值优先。
 */
function mergeProcessEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (typeof process === "undefined") {
    return env;
  }

  return {
    ...process.env,
    ...env
  };
}

interface ResolvedEnvConfig {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  supportedApiKeyEnv: string[];
  supportedModelEnv: string[];
}

/**
 * 解析当前要使用的模型 profile，让同一份 .env 可以同时保存多组模型配置。
 *
 * @param env 可注入的环境变量集合。
 * @returns 当前模型 profile，默认使用 default profile。
 */
function resolveProfile(env: Record<string, string | undefined>): string {
  const profile = env.AIAGENT_LLM_PROVIDER ?? env.MODEL_PROVIDER;

  if (!profile || profile === "openai-compatible") {
    return DEFAULT_PROFILE;
  }

  if (profile === "kimi-code") {
    return "kimi";
  }

  return profile;
}

/**
 * 按 profile 解析 OpenAI compatible 配置，优先读取 AIAGENT_LLM_*_<PROFILE> 命名。
 *
 * @param env 可注入的环境变量集合。
 * @param profile 当前模型 profile。
 * @returns 归一化前的 provider 配置。
 */
function resolveProfileConfig(env: Record<string, string | undefined>, profile: string): ResolvedEnvConfig {
  const suffix = toEnvSuffix(profile);
  const profileApiKeyEnv = `AIAGENT_LLM_API_KEY_${suffix}`;
  const profileBaseUrlEnv = `AIAGENT_LLM_BASE_URL_${suffix}`;
  const profileModelEnv = `AIAGENT_LLM_MODEL_${suffix}`;

  if (profile === "kimi") {
    return resolveKimiProfileConfig(env, profileApiKeyEnv, profileBaseUrlEnv, profileModelEnv);
  }

  return {
    apiKey: env[profileApiKeyEnv] ?? env.AIAGENT_LLM_API_KEY ?? env.OPENAI_API_KEY ?? env.MODEL_API_KEY,
    baseUrl:
      env[profileBaseUrlEnv] ??
      env.AIAGENT_LLM_BASE_URL ??
      env.OPENAI_BASE_URL ??
      env.MODEL_BASE_URL ??
      DEFAULT_BASE_URL,
    model: env[profileModelEnv] ?? env.AIAGENT_LLM_MODEL ?? env.OPENAI_MODEL ?? env.MODEL_NAME,
    supportedApiKeyEnv: [profileApiKeyEnv, "AIAGENT_LLM_API_KEY", "OPENAI_API_KEY", "MODEL_API_KEY"],
    supportedModelEnv: [profileModelEnv, "AIAGENT_LLM_MODEL", "OPENAI_MODEL", "MODEL_NAME"]
  };
}

/**
 * 解析 Kimi profile 配置，并兼容 Claude Code 常用的 Anthropic 环境变量。
 *
 * @param env 可注入的环境变量集合。
 * @param profileApiKeyEnv Kimi profile 的标准 API key 变量名。
 * @param profileBaseUrlEnv Kimi profile 的标准 base URL 变量名。
 * @param profileModelEnv Kimi profile 的标准 model 变量名。
 * @returns 归一化前的 Kimi profile 配置。
 */
function resolveKimiProfileConfig(
  env: Record<string, string | undefined>,
  profileApiKeyEnv: string,
  profileBaseUrlEnv: string,
  profileModelEnv: string
): ResolvedEnvConfig {
  return {
    apiKey: env[profileApiKeyEnv] ?? env.MODEL_API_KEY_KIMI ?? env.KIMI_API_KEY ?? env.ANTHROPIC_API_KEY,
    baseUrl:
      env[profileBaseUrlEnv] ??
      env.MODEL_BASE_URL_KIMI ??
      env.KIMI_BASE_URL ??
      mapKimiAnthropicBaseUrl(env.ANTHROPIC_BASE_URL) ??
      KIMI_CODE_OPENAI_BASE_URL,
    model: env[profileModelEnv] ?? env.MODEL_NAME_KIMI ?? env.KIMI_MODEL ?? env.ANTHROPIC_MODEL ?? KIMI_CODE_MODEL,
    supportedApiKeyEnv: [profileApiKeyEnv, "MODEL_API_KEY_KIMI", "KIMI_API_KEY", "ANTHROPIC_API_KEY"],
    supportedModelEnv: [profileModelEnv, "MODEL_NAME_KIMI", "KIMI_MODEL", "ANTHROPIC_MODEL"]
  };
}

/**
 * 将 profile 名称转换为环境变量后缀，例如 deepseek-v3 会变成 DEEPSEEK_V3。
 *
 * @param profile 模型 profile 名称。
 * @returns 可拼接到 AIAGENT_LLM_*_ 后面的环境变量后缀。
 */
function toEnvSuffix(profile: string): string {
  return profile
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/**
 * 将 Kimi Code 的 Anthropic-compatible base URL 转为同服务的 OpenAI-compatible base URL。
 *
 * @param baseUrl Anthropic-compatible base URL，例如 https://api.kimi.com/coding/。
 * @returns OpenAI-compatible base URL；无法识别时返回 undefined。
 */
function mapKimiAnthropicBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized === "https://api.kimi.com/coding") {
    return KIMI_CODE_OPENAI_BASE_URL;
  }

  return undefined;
}

/**
 * 解析可选超时配置，避免非法数字进入请求控制流。
 *
 * @param timeoutValue 环境变量中的超时文本。
 * @returns 成功时返回 timeoutMs，失败时返回配置错误。
 */
function parseTimeoutMs(timeoutValue: string | undefined): LlmResult<number | undefined> {
  const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: "AIAGENT_LLM_TIMEOUT_MS must be a positive number.",
        details: { timeoutValue }
      }
    };
  }

  return { ok: true, data: timeoutMs };
}

/**
 * 读取默认运行环境，兼容浏览器等没有 process 的执行上下文。
 *
 * @returns 当前进程环境变量；不可用时返回空对象。
 */
function getDefaultEnv(): Record<string, string | undefined> {
  loadProjectEnv();
  return typeof process === "undefined" ? {} : process.env;
}

/**
 * 自动加载当前项目的 .env，让本地 Node 进程无需在每个入口重复显式注入环境变量。
 *
 * @returns 无返回值。
 */
function loadProjectEnv(): void {
  if (projectEnvLoaded || typeof process === "undefined") {
    return;
  }

  projectEnvLoaded = true;

  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  const envFile = findUpFile(".env", process.cwd());
  if (envFile) {
    process.loadEnvFile(envFile);
  }
}

/**
 * 从起始目录向上查找指定文件，用于兼容 pnpm filter 改变 package 工作目录的场景。
 *
 * @param fileName 要查找的文件名。
 * @param startDir 起始目录。
 * @returns 找到时返回绝对路径；未找到时返回 undefined。
 */
function findUpFile(fileName: string, startDir: string): string | undefined {
  let current = startDir;

  while (true) {
    const candidate = resolve(current, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}
