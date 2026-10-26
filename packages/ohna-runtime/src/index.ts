/**
 * `@aiagent/ohna-runtime` 公共入口。
 *
 * 本包是 ohna 桌面 runtime 的共享内核包：从 `@aiagent/serve` 抽离的 JSONL 存储端口、
 * RunManager 与组合根 `createOhnaRuntime` 都收敛到此，保持「无 Fastify/Electron/React」
 * 的纯 Node 依赖边界。serve 侧改为 re-export 本包以维持过渡期公共 API 不变。
 */
export * from "./store/index.js";

/**
 * 跨进程边界的错误归一与入参形状校验（spec §4.2）。
 * `toRuntimeError` 把任意错误收敛为 `RuntimeErrorDto`；`assertProtocolVersion` /
 * `validateString` / `validateId` 在 preload / runtime 边界做 fail-closed 形状校验。
 */
export * from "./errors.js";
export * from "./validation.js";

/**
 * 组合根与 RunManager（runtime 执行核心）。
 * `createOhnaRuntime` 是桌面形态下唯一对外装配入口；`RunManager` 保留导出供后续任务改造其内部。
 */
export * from "./runtime.js";
export { RunManager } from "./run-manager.js";
