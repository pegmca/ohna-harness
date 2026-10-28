import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceConfig } from "../core/workspace.js";
import { HttpError, toErrorEnvelope } from "./errors.js";
import { handleActions } from "./routes/actions.js";
import { handleBatches } from "./routes/batches.js";
import { handleDrafts } from "./routes/drafts.js";
import { handleEvidence } from "./routes/evidence.js";
import type {
  GoldenStudioServerOptions,
  RequestContext,
  RouteResponse,
  ServerHandle
} from "./types.js";

/** 默认允许的 JSON 请求体大小。 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * 创建只绑定本机用途的 Golden Studio HTTP server。
 *
 * 路由只校验运输边界并调用 core；批次与草稿 ID 在核心调用前先经过
 * 核心提供的路径段守卫。PDF 读取由 core 的 manifest 白名单与包含检查收口。
 *
 * @param config 已解析的工作区配置。
 * @param options 请求体上限等 server 选项。
 * @returns 带 listen/close 的 server 句柄。
 */
export function createGoldenStudioServer(
  config: WorkspaceConfig,
  options: GoldenStudioServerOptions = {}
): ServerHandle {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((request, response) => {
    void dispatch(config, request, response, maxBodyBytes);
  });

  return {
    server,
    listen: (port = 4318, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        if (!isLoopbackHost(host)) {
          reject(
            new HttpError(
              400,
              "invalid_request",
              "Local server can only bind to a loopback host.",
              { host }
            )
          );
          return;
        }
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("HTTP server did not expose a TCP address."));
            return;
          }
          resolve({ host, port: address.port });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

/**
 * 分派一个真实 HTTP 请求并写回响应。
 *
 * @param config 工作区配置。
 * @param request 原始请求。
 * @param response 原始响应。
 * @param maxBodyBytes 请求体上限。
 */
async function dispatch(
  config: WorkspaceConfig,
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const segments = apiSegments(url.pathname);
    if (!segments) throw unknownRoute(url.pathname);
    const context: RequestContext = { config, request, response, url, maxBodyBytes };
    const result =
      (await handleBatches(context, segments)) ??
      (await handleDrafts(context, segments)) ??
      (await handleEvidence(context, segments)) ??
      (await handleActions(context, segments));
    if (!result) throw unknownRoute(url.pathname);
    writeResponse(response, result);
  } catch (error) {
    const mapped = toErrorEnvelope(error);
    writeJson(response, mapped.status, mapped.body, methodHeaders(error));
  }
}

/**
 * 判断监听地址是否为本机回环地址。
 *
 * @param host 调用方提供的监听主机。
 * @returns localhost、IPv4 或 IPv6 回环地址时为 true。
 */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * 将 `/api/...` 拆成路径段，允许末尾单个 `/` 并保持严格匹配。
 *
 * @param pathname URL 路径。
 * @returns 段；不是 API 路径时为 undefined。
 */
function apiSegments(pathname: string): string[] | undefined {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  const parts = normalized.split("/");
  if (parts[0] !== "" || parts[1] !== "api") return undefined;
  return parts.slice(2);
}

/**
 * 写入路由响应。
 *
 * @param response Node 响应。
 * @param result 结构化路由结果。
 */
function writeResponse(response: ServerResponse, result: RouteResponse): void {
  if (result.kind === "json") {
    writeJson(response, result.status, result.body, result.headers);
    return;
  }
  if (result.kind === "empty") {
    response.statusCode = result.status;
    writeHeaders(response, result.headers);
    response.end();
    return;
  }
  response.statusCode = result.status;
  writeHeaders(response, result.headers);
  response.end(result.body);
}

/**
 * 发送 JSON 响应。
 *
 * @param response Node 响应。
 * @param status HTTP 状态。
 * @param body 可序列化对象。
 * @param headers 额外响应头。
 */
function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  writeHeaders(response, headers);
  response.end(JSON.stringify(body));
}

/**
 * 写入已经验证过的响应头。
 *
 * @param response Node 响应。
 * @param headers 响应头集合。
 */
function writeHeaders(
  response: ServerResponse,
  headers: Record<string, string> = {}
): void {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}

/**
 * 构造未知路由错误。
 *
 * @param pathname 请求路径。
 * @returns 404 路由错误。
 */
function unknownRoute(pathname: string): HttpError {
  return new HttpError(404, "not_found", "API route was not found.", { pathname });
}

/**
 * 提取 405 响应的 Allow 头。
 *
 * @param error 捕获异常。
 * @returns 响应头。
 */
function methodHeaders(error: unknown): Record<string, string> {
  if (!(error instanceof HttpError)) return {};
  const allowed = error.details.allowed;
  return typeof allowed === "string" ? { allow: allowed } : {};
}
