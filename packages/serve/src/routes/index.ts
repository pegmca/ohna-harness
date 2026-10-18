/**
 * 路由装配入口：按域注册，避免单文件膨胀，也方便 Phase 3/4 增删端点。
 */
import type { FastifyInstance } from "fastify";
import { registerConfirmationRoutes } from "./confirmations.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerEventRoutes } from "./events.js";
import { registerFsRoutes } from "./fs.js";
import { registerHealthRoutes } from "./health.js";
import { registerIdentityRoutes } from "./identity.js";
import { registerModelRoutes } from "./models.js";
import { registerRunRoutes } from "./runs.js";
import type { RouteDeps } from "./types.js";

/**
 * 注册全部 ohna 本地路由（L1：含确认闸门与只读 fs）。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerHealthRoutes(app, deps);
  registerIdentityRoutes(app, deps);
  registerModelRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerConfirmationRoutes(app, deps);
  registerFsRoutes(app, deps);
}

export type { RouteDeps } from "./types.js";
