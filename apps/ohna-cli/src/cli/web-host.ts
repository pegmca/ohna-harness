/**
 * 进程内 Web 观测台装配（docs/v1.4/02-web-llm-trace.md 的 W3）。
 *
 * 两条入口共用本模块：
 * - 默认模式：`ohna` = TUI repl **本地执行** + 进程内 serve 只做镜像观测（D1）；
 * - 托管模式：`ohna --web` = 执行权交给 serve（语义不变）。
 *
 * 差异只在「谁调 createRun」：本模块只负责把 server / URL / conversation 装起来。
 * 装配失败（端口耗尽、工作区不可写、静态产物缺失等）一律 resolve `undefined`，
 * 由调用方降级为纯本地运行——观测缺失不能阻塞 CLI（D10）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ActiveModel } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import { createOhnaServer, listenWithRetry, type OhnaServer } from "@aiagent/serve";

/** 装配参数。 */
export interface HostOptions {
  /** 工作区根目录（编码工具的唯一作用域）。 */
  workspaceRoot: string;
  /** 已解析的真实模型与凭据。 */
  active: ActiveModel;
  /** 已装配的工具表（编码工具 + MCP）。 */
  tools: AgentTool<any>[];
  /** --yes：跳过写/执行确认（观测台模式下同样生效）。 */
  autoApprove: boolean;
  /**
   * 只读观测模式（S2）：默认 `ohna` 传 true（serve 只承接镜像事件，不注册写 run/确认端点）；
   * `--web` 托管模式传 false（执行权在 serve）。
   */
  observeOnly?: boolean;
  /** 起始端口（占用自动 +1）。 */
  port: number;
  /** 观测台会话标题。 */
  conversationTitle: string;
  /** 数据目录覆盖（缺省 `~/.ohna`）；测试与多实例隔离时使用。 */
  dataDir?: string;
}

/** 装配结果。 */
export interface HostResult {
  server: OhnaServer;
  url: string;
  /**
   * 观测台会话 id。托管模式下为「待创建」占位（空串）：会话落盘的唯一触发点是
   * 「首条真实 message 发送」，因此装配阶段不再 eager 建会话；`--web` 入口在首条消息
   * 到达时才 `server.createConversation`。默认模式（observeOnly）仍需要一条镜像会话，
   * 由调用方显式创建后写入。
   */
  conversationId: string;
}

/**
 * 进程内是否已经有一个 host。
 *
 * 单入口分发天然保证同一进程只会走一条（默认或 --web），这里保留显式断言，
 * 防止未来引入插件式入口时同进程双起两个 server 抢占同一数据目录。
 */
let hosting = false;

/**
 * 在 127.0.0.1 上起 serve 并创建一个观测台会话。
 *
 * @param options 工作区、模型、工具、端口与会话标题。
 * @returns 装配结果；任何失败都 resolve undefined（调用方降级为纯本地）。
 */
export async function hostOhnaWeb(options: HostOptions): Promise<HostResult | undefined> {
  if (hosting) {
    process.stderr.write("⚠️ 进程内已有观测台，跳过重复装配。\n");
    return undefined;
  }
  hosting = true;

  let server: OhnaServer | undefined;
  try {
    // 静态产物缺失时 serve 会渲染内置占位页；这里提前给一句可操作的构建提示。
    await warnIfWebDistMissing();

    server = await createOhnaServer({
      workspaceRoot: options.workspaceRoot,
      model: options.active.model,
      apiKey: options.active.apiKey,
      tools: options.tools,
      autoApprove: options.autoApprove,
      observeOnly: options.observeOnly === true,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    });
    const listening = await listenWithRetry(server, options.port);
    // 会话创建策略按模式区分（BUG 空会话落盘）：
    // - 托管模式（--web，observeOnly=false）：不 eager 建会话，返回空占位 id，
    //   由 web-entry 在首条真实消息到达时懒创建。
    // - 默认观测模式（observeOnly=true）：serve 只做 CLI 本地会话的镜像观测，
    //   需要一条与进程同生共死的镜像会话承接 run 事件，仍在此 eager 创建。
    const conversation = options.observeOnly === true
      ? await server.createConversation(options.conversationTitle)
      : { conversationId: "" as string } as { conversationId: string };
    return { server, url: listening.url, conversationId: conversation.conversationId };
  } catch (error) {
    hosting = false;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`⚠️ 观测台启动失败（${message}），已降级为纯本地模式。\n`);
    // 半装配的 server 必须关掉，否则残留的 Fastify 监听会拖住进程退出。
    await server
      ?.shutdown()
      .then(() => server?.close())
      .catch(() => undefined);
    return undefined;
  }
}

/**
 * 观测台装配成功后释放单例标记（进程退出 / 测试重建时调用）。
 *
 * 正常 CLI 生命周期不需要调用：host 与进程同生共死。
 */
export function releaseHost(): void {
  hosting = false;
}

/**
 * 检查前端构建产物是否存在；缺失只打印构建提示，不阻断（serve 有占位页）。
 */
async function warnIfWebDistMissing(): Promise<void> {
  const staticDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../ohna-web/dist",
  );
  try {
    await fs.access(path.join(staticDir, "index.html"));
  } catch {
    process.stderr.write(
      "⚠️ 未找到 apps/ohna-web/dist（可运行 `pnpm --filter @aiagent/ohna-web build`）；当前展示内置占位页。\n",
    );
  }
}

/**
 * 跨平台打开浏览器；失败只提示 URL，不抛错。
 *
 * @param url 要打开的地址。
 */
export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  try {
    const child = spawn(command.file, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => process.stdout.write(`无法自动打开浏览器，请手动访问：${url}\n`));
    child.unref();
  } catch {
    process.stdout.write(`无法自动打开浏览器，请手动访问：${url}\n`);
  }
}
