/**
 * 路由装配共享依赖：server 负责构造，各 route 文件只消费端口。
 */
import type { Model } from "@aiagent/ai";
import type { ModelCatalogDto } from "@aiagent/types";
import type { RunManager } from "../run-manager.js";
import type { LocalMessageStore, LocalRunStore, LocalSessionStore } from "../store/index.js";

/** 所有路由共享的装配上下文。 */
export interface RouteDeps {
  workspaceRoot: string;
  dataDir: string;
  model: Model<"openai-completions">;
  modelCatalog: ModelCatalogDto;
  sessionStore: LocalSessionStore;
  messageStore: LocalMessageStore;
  runStore: LocalRunStore;
  runManager: RunManager;
  /** 进程 pid，用于 health 诊断。 */
  pid: number;
  /** 关闭中标志：新 run / 写操作返回 503。 */
  isShuttingDown: () => boolean;
  /**
   * 只读观测模式（S2）：默认 `ohna` 的进程内 serve 只承接 CLI 镜像事件，
   * 因此不注册 `POST /api/runs` / `DELETE /api/runs/:id` / 确认写路由——执行权只在 CLI 本地，
   * 浏览器不能借观测台发起或取消 run。GET 端点全部保留。
   */
  observeOnly?: boolean;
}
