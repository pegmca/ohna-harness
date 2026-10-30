/**
 * `@aiagent/ohna-runtime` 公共入口。
 *
 * 本包是 ohna 桌面 runtime 的共享内核包：JSONL 存储端口、RunManager 与组合根
 * `createOhnaRuntime` 都收敛到此，保持「无 Fastify/Electron/React」的纯 Node 依赖边界。
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
export * from "./config/settings-store.js";
export { RunManager } from "./run-manager.js";
export type { Subscription, SubscribeOptions } from "./events/subscription.js";
export * from "./model/config.js";
export * from "./scheduler/conversation.js";

/**
 * 工作区授权与归属校验模块：registry（授权表 + 归属反查）、context（上下文缓存）、
 * mcp（MCP 会话生命周期容器）。三者只在 runtime 边界内持有，渲染端仅以 `workspaceId`
 * 操作资源，绝对根目录不离开 runtime。
 */
export * from "./workspace/index.js";
