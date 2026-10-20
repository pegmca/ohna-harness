/**
 * `--no-web` 降级 sink：把 `LlmCallRecordDto` 追加写到 `~/.ohna/traces/<sessionId>.jsonl`。
 *
 * 为什么保留文件通道（D10）：观测台起不来（端口耗尽 / 用户显式 --no-web）时，
 * 「每次 LLM 请求参数」仍要可事后排查；每行一条记录，`jq` 即可消费。
 * 写失败一律静默降级——观测绝不能阻塞 CLI。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LlmTraceSink } from "@aiagent/agent";

/** 默认目录：`~/.ohna/traces`。 */
export function defaultTraceDir(): string {
  return path.join(os.homedir(), ".ohna", "traces");
}

/** 已确保存在的目录（避免每条记录都 mkdir）。 */
const ensuredDirs = new Set<string>();

/**
 * 每个文件一条写入链：`appendFile` 并发调用不保证落盘顺序，而 trace 读回时依赖
 * 「按调用时间排列」。串行化同时让 flush 有确定的完成点。
 */
const writeChains = new Map<string, Promise<void>>();

/**
 * 在飞写入集合：sink 是同步契约（fire-and-forget），但退出前必须能等它们落盘，
 * 否则单次 `--prompt` 的最后一条记录可能在 append 完成前随进程消失（N1）。
 */
const pendingWrites = new Set<Promise<void>>();

/**
 * 等待所有已排队的 trace 文件写入完成。
 *
 * 循环等待是因为 await 期间可能仍有新的写入被排入（正常退出路径下通常只有一轮）。
 *
 * @returns 全部写入结束（含失败被吞掉的）后 resolve。
 */
export async function flushTraceWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }
}

/**
 * 把会话 id 收敛成安全文件名：只保留字母/数字/下划线/连字符。
 *
 * 白名单天然排除 `/`、`\`、`.`，因此 `../` 这类路径逃逸会被替换成下划线（禁止穿越）。
 *
 * @param sessionId 原始会话 id。
 * @returns 安全文件名片段（空值回退 `unknown-session`）。
 */
function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return safe.length > 0 ? safe : "unknown-session";
}

/**
 * 创建按会话分文件的 JSONL sink。
 *
 * @param sessionId 会话 id（用于文件名，非法字符会被替换，防止路径逃逸）。
 * @param baseDir 目录覆盖（测试注入；缺省 `~/.ohna/traces`）。
 * @returns 可直接交给 `createLlmTraceStreamFn` 的 sink。
 */
export function createLlmTraceFileSink(
  sessionId: string,
  baseDir: string = defaultTraceDir(),
): LlmTraceSink {
  const filePath = path.join(baseDir, `${sanitizeSessionId(sessionId)}.jsonl`);
  // 双保险：即使白名单将来被放宽，也不允许写到 baseDir 之外。
  if (path.dirname(path.resolve(filePath)) !== path.resolve(baseDir)) {
    return () => undefined;
  }

  return (record) => {
    // 单次 append 失败不影响 run；不 await、不抛错（sink 是同步契约），
    // 但把 Promise 登记到 pendingWrites，退出时由 flushTraceWrites 兜底等待。
    const previous = writeChains.get(filePath) ?? Promise.resolve();
    const task = previous.then(async () => {
      try {
        if (!ensuredDirs.has(baseDir)) {
          await fs.mkdir(baseDir, { recursive: true });
          ensuredDirs.add(baseDir);
        }
        await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        // 磁盘满 / 权限不足：观测静默降级，run 继续。
      }
    });
    writeChains.set(filePath, task);
    pendingWrites.add(task);
    void task.finally(() => pendingWrites.delete(task));
  };
}
