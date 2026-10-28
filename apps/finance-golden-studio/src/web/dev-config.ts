/**
 * 本地开发服务的共享端口约定。
 *
 * CLI serve 与 Vite `/api` 代理都读取同一常量，避免一键 dev 启动后
 * 两个进程指向不同端口。
 */
export const DEV_API_PORT = 4318;

/** Vite 代理访问本地 API 的完整地址。 */
export const DEV_API_URL = `http://127.0.0.1:${DEV_API_PORT}`;
