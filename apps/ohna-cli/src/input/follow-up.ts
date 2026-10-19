/**
 * run 进行中的输入排队协议（K2）：pending 队列、steering / follow-up 钩子与 abort 闸门。
 *
 * 为什么独立成模块：这部分是「CLI 输入」与「内核循环」之间唯一的协议胶水，状态机
 * （排队 → 分区 → 注入 / 串行兜底）比 REPL 的装配细节更值得单独阅读与测试；拆出后
 * repl.ts 只负责把钩子传给 runTurn，不再持有队列规则。
 *
 * 核心不变量：slash 命令与 `!` / `#` 直通命令**绝不**作为 follow-up 注入模型。
 * 命令是会话级动作（/cost、/exit、/clear、bash 直通、记忆写入等），必须留在队列里交给
 * processLine 的串行分支按原逻辑分发；只有普通文本才会被内核当作 user 消息续进当前 run。
 */
import type { AgentMessage } from "@aiagent/agent";
import { parseSlashCommand } from "../commands/slash.js";

/** 排队行的分区结果：可注入当前 run 的普通文本 + 必须串行执行的 slash 命令。 */
export interface QueuedLinePartition {
  /** 普通文本（保持相对顺序），可包装成 user 消息注入当前 run。 */
  followUps: string[];
  /** slash 命令（保持相对顺序），留给 run 结束后的串行分发。 */
  commands: string[];
}

/**
 * 把排队行分区：普通文本走 follow-up，slash / `!` / `#` 命令留队。
 *
 * 取舍：分区而不是「遇到命令就停止排空」，保证一条命令不会阻塞它后面的普通文本；
 * 代价是命令与它之后文本的相对顺序会变成「文本先注入当前 run、命令 run 后执行」。
 * 命令都是会话级动作，这种重排比「把命令发给模型」安全得多。
 *
 * `!` / `#` 也必须留队：直通命令不能进入模型上下文（否则模型会看到未执行的字面命令，
 * 且 `!` 的结果语义会被破坏）。
 *
 * @param lines 当前排队行（按提交顺序）。
 * @returns 普通文本与命令两个保持各自相对顺序的数组。
 */
export function partitionQueuedLines(lines: readonly string[]): QueuedLinePartition {
  const followUps: string[] = [];
  const commands: string[] = [];
  for (const line of lines) {
    if (parseSlashCommand(line) || line.startsWith("!") || line.startsWith("#")) commands.push(line);
    else followUps.push(line);
  }
  return { followUps, commands };
}

/**
 * 排队控制器：REPL 只通过它读写 pending，内核只通过两个钩子拉取消息。
 *
 * `disabled` 是 abort 闸门：Esc / Ctrl+C 中断后置位，避免 follow-up 把排队消息
 * 注入一个即将终止的 run（消息进了 history 却没人回答）。队列本身保留，run 收尾后
 * 由 processLine 的 finally 串行处理；下一次 run 开始时 {@link reset} 复位。
 */
export interface FollowUpController {
  /**
   * 入队一行。
   *
   * @param text 已 trim 的输入。
   * @returns 入队后的队列序号（从 1 起，用于 `» 已排队（#N）` 回显）。
   */
  enqueue(text: string): number;
  /** 队列是否还有待处理行（EOF / /exit 的收尾判定用）。 */
  hasPending(): boolean;
  /**
   * 取出一行交给 processLine 串行处理。
   *
   * @returns 队首行；空队列返回 undefined。
   */
  shift(): string | undefined;
  /** 清空队列（/exit 与中断退出时丢弃未处理输入）。 */
  clear(): void;
  /**
   * steering 钩子：B1 暂无独立输入通道，恒返回空数组。
   *
   * @returns 空数组。
   */
  getSteeringMessages(): Promise<AgentMessage[]>;
  /**
   * follow-up 钩子：把普通文本排空为 user 消息；命令留在队列里。
   *
   * @returns 待注入的 user 消息；无普通文本或已 abort 时返回空数组。
   */
  getFollowUpMessages(): Promise<AgentMessage[]>;
  /** abort 闸门：中断当前 run 时禁止 follow-up 注入。 */
  disable(): void;
  /** 复位 abort 闸门（run 开始 / 收尾时调用）。 */
  reset(): void;
}

/**
 * 创建排队控制器。
 *
 * @returns 供 repl 装配与 runTurn 使用的 FollowUpController。
 */
export function createFollowUpController(): FollowUpController {
  let pending: string[] = [];
  /** abort 闸门：为 true 时 follow-up 返回空，把队列留给串行兜底。 */
  let disabled = false;

  return {
    enqueue(text: string): number {
      pending.push(text);
      return pending.length;
    },
    hasPending(): boolean {
      return pending.length > 0;
    },
    shift(): string | undefined {
      return pending.shift();
    },
    clear(): void {
      pending = [];
    },
    async getSteeringMessages(): Promise<AgentMessage[]> {
      // B1 不接 steering 来源：普通排队走 follow-up（等 agent 可停时续跑），
      // 而不是「下一轮 LLM 前抢先注入」。两者语义不同，不能互相顶替。
      return [];
    },
    async getFollowUpMessages(): Promise<AgentMessage[]> {
      if (disabled || pending.length === 0) return [];
      const { followUps, commands } = partitionQueuedLines(pending);
      // 只把普通文本移出队列；命令原样留下，交给 finally 的串行分发。
      pending = commands;
      const timestamp = Date.now();
      return followUps.map((content) => ({ role: "user", content, timestamp }));
    },
    disable(): void {
      disabled = true;
    },
    reset(): void {
      disabled = false;
    },
  };
}
