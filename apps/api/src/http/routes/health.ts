import type { FastifyInstance } from "fastify";

export interface HealthRoutesDeps {
  readiness?: () => Promise<{ ok: boolean; dependency: string; message?: string }>;
}

/**
 * 注册健康检查与 readiness 路由。
 *
 * @param app Fastify 实例。
 * @param deps readiness 依赖探针；未注入时按默认就绪（api-server）处理。
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthRoutesDeps): void {
  /**
   * 健康检查接口只暴露 API 服务存活状态，供本地 dev server、脚本和部署探针快速验证。
   *
   * @returns 服务名称和 ok 状态。
   */
  app.get("/health", async () => ({
    ok: true,
    service: "@aiagent/api"
  }));

  /** readiness 会检查启动模式所需依赖；失败返回 503，避免流量进入不可服务实例。 */
  app.get("/ready", async (_request, reply) => {
    const state = deps.readiness
      ? await deps.readiness()
      : { ok: true, dependency: "api-server" };
    if (!state.ok) reply.code(503);
    return { ...state, service: "@aiagent/api" };
  });
}
