#!/usr/bin/env node
/**
 * ohna-api 薄入口：只做进程生命周期。
 *
 * 模型解析（`resolveActiveModelFromEnv`）、系统提示词（`buildCodingSystemPrompt`）、
 * 服务端装配（`createOhnaServer`）全部复用 packages 层；本文件不实现 agent 逻辑，
 * 也不注册任何业务路由。未来 `ohna-cli --web` 复用同一个 serve 装配。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import { resolveActiveModelFromEnv } from "@aiagent/ai";
import { buildCodingSystemPrompt } from "@aiagent/coding";
import { createOhnaServer, ensureDataDir, listenWithRetry } from "@aiagent/serve";
import { parseOhnaApiArgs, printHelp } from "./args.js";

/**
 * 解析 ohna-web 构建产物目录（Phase 4 静态托管接线）。
 *
 * 以本文件编译产物（apps/ohna-api/dist/index.js）为基准回溯两级到 apps/，
 * 再指向 ohna-web/dist——与 serve 的 defaultStaticDir 结论一致，但由入口显式解析，
 * 保证 `pnpm --filter @aiagent/ohna-web build` 之后无需任何配置即可托管真实 UI。
 *
 * @returns 构建产物目录绝对路径；目录不存在时返回 undefined（serve 退回占位页）。
 */
async function resolveWebDist(): Promise<string | undefined> {
  const candidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../ohna-web/dist"
  );
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 打印「没有可用 provider」的中文错误，并列出需要配置的环境变量。
 */
function printProviderError(): void {
  process.stderr.write(
    [
      "未检测到任何已配置的真实模型 provider，本地服务无法启动。",
      "",
      "请在 .env 中配置以下环境变量之一（API Key + Model 必须同时存在）：",
      "  AIAGENT_LLM_API_KEY_DEEPSEEK 与 AIAGENT_LLM_MODEL_DEEPSEEK",
      "  AIAGENT_LLM_API_KEY_OPENROUTER 与 AIAGENT_LLM_MODEL_OPENROUTER",
      "  AIAGENT_LLM_API_KEY_BRIDGE_AI、AIAGENT_LLM_BASE_URL_BRIDGE_AI 与 AIAGENT_LLM_MODEL_BRIDGE_AI",
      ""
    ].join("\n")
  );
}

/**
 * 跨平台打开浏览器；失败只打印 URL，不让服务启动失败。
 *
 * @param url 本地服务地址。
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      process.stdout.write(`无法自动打开浏览器，请手动访问：${url}\n`);
    });
    child.unref();
  } catch {
    process.stdout.write(`无法自动打开浏览器，请手动访问：${url}\n`);
  }
}

/**
 * 主流程：解析参数 → 解析模型 → 装配 serve → listen → 打开浏览器 → 等待信号。
 */
async function main(): Promise<void> {
  const options = parseOhnaApiArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const workspaceRoot = path.resolve(options.dir ?? process.cwd());
  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    process.stderr.write(`工作区目录不存在或不可访问：${workspaceRoot}\n`);
    process.exit(1);
  }

  const dataDir = path.resolve(options.dataDir ?? path.join(os.homedir(), ".ohna"));
  await ensureDataDir(dataDir);

  const active = resolveActiveModelFromEnv();
  if (!active) {
    printProviderError();
    process.exit(1);
  }

  const systemPrompt = await buildCodingSystemPrompt(workspaceRoot, {
    onContextError: () => undefined
  });
  // ohna-web/dist 存在时由 serve 直接托管本地 UI；不存在时占位页提示先构建前端。
  const staticDir = await resolveWebDist();
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: active.model,
    apiKey: active.apiKey,
    systemPrompt,
    autoApprove: options.autoApprove,
    ...(staticDir ? { staticDir } : {})
  });

  let listening: { port: number; url: string };
  try {
    listening = await listenWithRetry(server, options.port);
  } catch (error) {
    process.stderr.write(
      `监听端口失败：${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    [
      "ohna-api · 本地编码 Agent 已启动",
      `  工作目录：${workspaceRoot}`,
      `  数据目录：${dataDir}`,
      `  模型：${active.model.id}（${active.model.provider}）`,
      `  确认方式：${
        options.autoApprove
          ? "已自动批准写/执行（--auto-approve）"
          : "写/执行需在浏览器确认（read/grep/find/ls 无需确认）"
      }`,
      `  地址：${listening.url}`,
      ""
    ].join("\n")
  );

  if (options.open) {
    openBrowser(listening.url);
  } else {
    process.stdout.write(`已跳过自动打开浏览器（--no-open），请手动访问：${listening.url}\n`);
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      process.stderr.write(`\n收到 ${signal}，正在强制退出。\n`);
      process.exit(1);
    }
    shuttingDown = true;
    process.stdout.write(`\n收到 ${signal}，正在中断在途 Run 并关闭本地服务...\n`);
    void (async () => {
      try {
        await server.shutdown();
        await server.close();
      } catch (error) {
        process.stderr.write(
          `关闭时发生错误：${error instanceof Error ? error.message : String(error)}\n`
        );
      } finally {
        process.exit(0);
      }
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `ohna-api 启动失败：${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
