/**
 * 代理感知的 fetch：Node 内置 fetch 不读取系统代理，局域网/公司网关在 TUN 代理下会
 * 直接 EHOSTUNREACH。这里按显式环境变量注入 undici ProxyAgent，保持零配置时沿用全局 fetch。
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * 读取 HTTP 代理地址。
 *
 * 优先 `AIAGENT_HTTP_PROXY`，其次标准 `HTTPS_PROXY` / `HTTP_PROXY`；
 * 空串视为未配置，避免误把无效值交给 ProxyAgent。
 *
 * @param env 环境变量表。
 * @returns 代理 URL 或 undefined。
 */
export function resolveProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate =
    env.AIAGENT_HTTP_PROXY?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim();
  return candidate || undefined;
}

/**
 * 创建代理感知 fetch。
 *
 * @param env 环境变量表（测试注入）。
 * @returns 未配置代理时为全局 fetch，否则为带 ProxyAgent 的 fetch。
 */
export function createProxyAwareFetch(
  env: NodeJS.ProcessEnv = process.env
): typeof globalThis.fetch {
  const proxyUrl = resolveProxyUrl(env);
  if (!proxyUrl) return globalThis.fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  return ((input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher
    })) as typeof globalThis.fetch;
}
