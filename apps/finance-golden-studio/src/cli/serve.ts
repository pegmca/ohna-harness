import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceConfig } from "../core/workspace.js";
import { resolveWorkspaceConfig } from "../core/workspace.js";
import { createGoldenStudioServer } from "../server/http.js";
import type { ServerHandle } from "../server/types.js";
import { CliError } from "./args.js";

/** CLI 应用根目录。 */
const APP_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** 默认监听地址。 */
const DEFAULT_HOST = "127.0.0.1";
/** 默认 HTTP 端口。 */
const DEFAULT_PORT = 4318;

/** 可测试的 serve 依赖。 */
export interface ServeDependencies {
  config?: WorkspaceConfig;
  workspaceRoot?: string;
  corpusRoot?: string;
  createServer?: typeof createGoldenStudioServer;
  staticDir?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

/** 已启动的 serve 生命周期句柄。 */
export interface ServeHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * 解析环境变量并启动本地 Golden Studio。
 *
 * 启动错误先收敛为带 stage 的 CliError，CLI 再把阶段投影到稳定
 * serve_startup_failed 信封；成功输出只报告实际监听的 URL。
 *
 * @param dependencies 可注入的工作区、server 与输出端口。
 * @returns 实际监听地址与幂等关闭函数。
 * @throws {CliError} 工作区、监听或静态资源初始化失败时抛出。
 */
export async function startGoldenStudioServer(
  dependencies: ServeDependencies = {}
): Promise<ServeHandle> {
  let stage: "workspace" | "listen" = "workspace";
  let server: ServerHandle | undefined;
  try {
    const config =
      dependencies.config ??
      resolveWorkspaceConfig({
        ...(dependencies.workspaceRoot ?? process.env.GOLDEN_WORKSPACE_ROOT
          ? {
              workspaceRoot:
                dependencies.workspaceRoot ??
                (process.env.GOLDEN_WORKSPACE_ROOT as string)
            }
          : {}),
        ...(dependencies.corpusRoot ?? process.env.FINANCE_CORPUS_ROOT
          ? {
              corpusRoot:
                dependencies.corpusRoot ??
                (process.env.FINANCE_CORPUS_ROOT as string)
            }
          : {})
      });
    const staticDir =
      dependencies.staticDir ??
      process.env.GOLDEN_STUDIO_STATIC_DIR ??
      resolve(APP_ROOT, "dist", "web");
    server = (dependencies.createServer ?? createGoldenStudioServer)(config, {
      staticDir
    });
    stage = "listen";
    const host = process.env.GOLDEN_STUDIO_HOST ?? DEFAULT_HOST;
    const port = parsePort(process.env.GOLDEN_STUDIO_PORT);
    const address = await server.listen(port, host);
    const url = `http://${address.host}:${address.port}/`;
    dependencies.stdout?.write(`Golden Studio listening at ${url}\n`);
    let closing: Promise<void> | undefined;
    return {
      url,
      close: () => {
        closing ??= server?.close() ?? Promise.resolve();
        return closing;
      }
    };
  } catch (error) {
    await server?.close().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError(
      "serve_startup_failed",
      stage === "workspace"
        ? "Golden Studio could not resolve its workspace configuration."
        : "Golden Studio local server could not start.",
      {
        stage,
        ...(error instanceof Error ? { reason: error.message } : {})
      },
      error
    );
  }
}

/**
 * 安装 SIGINT/SIGTERM 优雅关闭；重复信号只关闭一次。
 *
 * @param handle 已启动服务句柄。
 * @returns 移除信号监听的清理函数。
 */
export function installShutdownSignals(handle: ServeHandle): () => void {
  const close = () => {
    void handle.close();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  return () => {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  };
}

/**
 * 解析可选端口，未设置时使用默认值。
 *
 * @param value 环境变量值。
 * @returns 0–65535 的端口。
 * @throws {CliError} 端口不是合法整数时抛出。
 */
function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new CliError(
      "serve_startup_failed",
      "GOLDEN_STUDIO_PORT must be an integer between 0 and 65535.",
      { stage: "listen", variable: "GOLDEN_STUDIO_PORT" }
    );
  }
  return port;
}
