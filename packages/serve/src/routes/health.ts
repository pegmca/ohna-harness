/**
 * 本地运行健康检查。
 *
 * 故意不包 `ApiResult`：ohna-web 需要用它判断 `mode:"local"`，
 * 一个稳定、扁平的形状比统一信封更适合作为「运行模式探针」。
 */
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./types.js";

/**
 * 注册 `GET /api/health`。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerHealthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/health", async () => ({
    mode: "local" as const,
    workspaceRoot: deps.workspaceRoot,
    model: { id: deps.model.id, provider: deps.model.provider },
    pid: deps.pid,
    dataDir: deps.dataDir
  }));
}
