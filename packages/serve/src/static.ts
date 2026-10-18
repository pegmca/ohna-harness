/**
 * 轻量静态服务 + SPA fallback。
 *
 * 为什么不用 `@fastify/static`：当前仓库没有安装该依赖，L0 只需「读文件 + 内容类型 + 防穿越」，
 * 用 `node:fs` 实现可以保持零新增依赖；Phase 4 真正接入 ohna-web 构建产物后，
 * 若需要 etag/range/gzip，再评估引入 `@fastify/static`（见 04 Phase 2 偏差说明）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/** 静态服务选项。 */
export interface StaticOptions {
  /** 前端构建产物目录（通常是 apps/ohna-web/dist）。 */
  staticDir: string;
  /** 工作区根目录，用于占位页展示。 */
  workspaceRoot: string;
}

/** 常见扩展名 → content-type。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

/**
 * 转义 HTML 文本，避免 workspaceRoot 中的 `<` 等字符破坏占位页。
 *
 * @param value 原始文本。
 * @returns 转义后的文本。
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 未构建前端时的占位页：包含 ohna 标识与当前工作区，便于确认服务确实指向目标目录。
 *
 * @param workspaceRoot 工作区根目录。
 * @returns HTML 文本。
 */
function placeholderHtml(workspaceRoot: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ohna · 本地编码 Agent</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #e8eaf0; }
    main { max-width: 640px; padding: 48px; }
    h1 { font-size: 40px; margin: 0 0 12px; letter-spacing: -0.04em; }
    p { line-height: 1.7; color: #aab0bf; }
    code { color: #8ab4ff; background: #1a1f2a; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>ohna</h1>
    <p>本地服务已启动，但前端构建产物尚不存在（<code>apps/ohna-web/dist</code>）。</p>
    <p>当前工作目录：<code>${escapeHtml(workspaceRoot)}</code></p>
    <p>L0 可直接使用 <code>POST /api/conversations</code>、<code>POST /api/runs</code> 与
    <code>GET /api/runs/:runId/events</code> 验证流式对话。</p>
  </main>
</body>
</html>`;
}

/**
 * 读取文件；不存在或不是普通文件返回 null。
 *
 * @param filePath 文件路径。
 * @returns Buffer 或 null。
 */
async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * 发送文件或占位页。
 *
 * @param reply Fastify 响应。
 * @param requestMethod HTTP 方法。
 * @param filePath 文件路径。
 * @param body 文件内容。
 */
function sendFile(
  reply: FastifyReply,
  requestMethod: string,
  filePath: string,
  body: Buffer
): void {
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  reply.code(200).header("content-type", contentType).send(requestMethod === "HEAD" ? undefined : body);
}

/**
 * 注册静态资源与 SPA fallback（Fastify notFound handler）。
 *
 * @param app Fastify 实例。
 * @param options 静态目录与工作区。
 */
export function registerStaticFallback(app: FastifyInstance, options: StaticOptions): void {
  const root = path.resolve(options.staticDir);

  app.setNotFoundHandler(async (request, reply) => {
    const urlPath = request.url.split("?")[0] ?? "/";

    // API 未命中保持 JSON 404，避免前端把 HTML 当 JSON 解析。
    if (urlPath === "/api" || urlPath.startsWith("/api/")) {
      reply.code(404).send({
        ok: false,
        requestId: "static",
        error: { code: "not_found", message: "接口不存在。", requestId: "static" }
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      reply.code(404).send({ ok: false, requestId: "static", error: { code: "not_found", message: "资源不存在。", requestId: "static" } });
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(urlPath);
    } catch {
      reply.code(400).send({ ok: false, requestId: "static", error: { code: "bad_request", message: "路径格式不正确。", requestId: "static" } });
      return;
    }

    // 防路径穿越：解析后必须仍位于静态根目录内。
    const resolved = path.resolve(root, `.${decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`}`);
    const withinRoot = resolved === root || resolved.startsWith(`${root}${path.sep}`);
    if (!withinRoot) {
      reply.code(404).send({ ok: false, requestId: "static", error: { code: "not_found", message: "资源不存在。", requestId: "static" } });
      return;
    }

    const direct = await readFileOrNull(resolved);
    if (direct) {
      sendFile(reply, request.method, resolved, direct);
      return;
    }

    const ext = path.extname(decodedPath);
    if (ext && ext !== ".html") {
      reply.code(404).send({ ok: false, requestId: "static", error: { code: "not_found", message: "资源不存在。", requestId: "static" } });
      return;
    }

    const index = await readFileOrNull(path.join(root, "index.html"));
    if (index) {
      sendFile(reply, request.method, path.join(root, "index.html"), index);
      return;
    }

    reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .send(request.method === "HEAD" ? undefined : placeholderHtml(options.workspaceRoot));
  });
}
