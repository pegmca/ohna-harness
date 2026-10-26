/**
 * `@aiagent/ohna-runtime` 公共入口。
 *
 * 本包是 ohna 桌面 runtime 的共享内核包：从 `@aiagent/serve` 抽离的 JSONL 存储端口
 * 与未来的 run / context / 资源管理能力都收敛到此，保持「无 Fastify/Electron/React」
 * 的纯 Node 依赖边界。serve 侧改为 re-export 本包以维持过渡期公共 API 不变。
 *
 * 当前只导出 store 子模块；后续 Task 会逐步迁入更多 runtime 能力。
 */
export * from "./store/index.js";
