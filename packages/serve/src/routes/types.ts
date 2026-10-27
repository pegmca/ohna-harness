/**
 * 路由装配共享依赖：server 负责构造，各 route 文件只消费端口。
 */
import type { Model } from "@aiagent/ai";
import type { ModelCatalogDto } from "@aiagent/types";
import type { OhnaRuntime } from "@aiagent/ohna-runtime";

/** 所有路由共享的装配上下文。 */
export interface RouteDeps {
  workspaceRoot: string;
  dataDir: string;
  model: Model<"openai-completions">;
  modelCatalog: ModelCatalogDto;
  /** 全部资源 / run / 确认 / 订阅能力的唯一入口（Task 11 后 serve 不再持有 store）。 */
  runtime: OhnaRuntime;
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
  /** 是否为自动批准模式（bypass 权限闸门）；只读观测实例恒为 false。 */
  isAutoApprove: boolean;
}
