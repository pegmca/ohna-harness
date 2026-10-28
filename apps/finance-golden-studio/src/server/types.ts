import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceConfig } from "../core/workspace.js";

/** server 构造选项，主要收口请求体上限以便测试和小型部署约束。 */
export interface GoldenStudioServerOptions {
  /** JSON 请求体的最大字节数，默认 1 MiB。 */
  maxBodyBytes?: number;
  /** 可选的 Vite 构建产物目录；提供时同源托管 SPA。 */
  staticDir?: string;
}

/** 路由层共享的请求上下文。 */
export interface RequestContext {
  config: WorkspaceConfig;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  maxBodyBytes: number;
}

/** 已解析并校验的动作请求体。 */
export interface ActionBody {
  confirm: true;
  batch?: string;
  id?: string;
  scope?: "batch" | "draft" | "golden";
}

/** 单个路由处理结果；undefined 表示该路由未匹配。 */
export type RouteResult = RouteResponse | undefined;

/** 路由写回响应所需的显式形状。 */
export type RouteResponse =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | {
      kind: "buffer";
      status: number;
      body: Buffer;
      headers: Record<string, string>;
    }
  | { kind: "empty"; status: number; headers?: Record<string, string> };

/** 对外暴露的 server 句柄。 */
export interface ServerHandle {
  readonly server: import("node:http").Server;
  listen(port?: number, host?: string): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}
