import { DEV_API_PORT, DEV_API_URL } from "../web/dev-config.js";

/** 一键 dev 使用的单个命令定义。 */
interface DevCommand {
  name: "api" | "web";
  color: "blue" | "green";
  command: string;
}

/** API 与 Web 的固定启动定义。 */
const DEV_COMMANDS: readonly DevCommand[] = [
  {
    name: "api",
    color: "blue",
    command: "node --import tsx --watch src/cli/main.ts serve"
  },
  {
    name: "web",
    color: "green",
    command: "vite"
  }
];

/**
 * 一键开发进程定义。
 *
 * 单一 dev 命令同时启动本地 HTTP/API server 与 Vite；Vite 的 `/api`
 * 代理固定指向同一 server 默认端口，避免 README 承诺两个进程却只启动一个。
 */
export interface DevProcess {
  name: "api" | "web";
  color: "blue" | "green";
  command: string;
  args: string[];
}

/**
 * 返回一键开发需要并行启动的进程。
 *
 * @returns API 与 Web 的固定启动顺序。
 */
export function devProcesses(): DevProcess[] {
  return DEV_COMMANDS.map((process) => ({
    ...process,
    args: process.command.split(/\s+/u)
  }));
}

/**
 * 把进程定义投影为可复现的 concurrently 命令。
 *
 * @param processes API 与 Web 进程定义。
 * @returns package script 内容。
 */
export function buildDevCommand(processes: readonly DevProcess[]): string {
  const names = processes.map(({ name }) => name).join(",");
  const colors = processes.map(({ color }) => color).join(",");
  const commands = processes
    .map(({ command }) => JSON.stringify(command))
    .join(" ");
  return `concurrently -k -n ${names} -c ${colors} ${commands}`;
}

/**
 * 校验 dev 进程与代理共享同一 API 端口。
 *
 * @returns 代理地址使用共享默认端口时为 true。
 */
export function devProxyMatchesApi(): boolean {
  return DEV_API_URL.endsWith(`:${DEV_API_PORT}`);
}
