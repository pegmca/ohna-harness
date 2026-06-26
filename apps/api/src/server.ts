import { createApiServer } from "./index.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const app = createApiServer();

/**
 * 启动本地 Fastify 服务，保持入口文件只负责进程生命周期。
 *
 * @returns 服务启动 Promise。
 */
async function start(): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void start();
