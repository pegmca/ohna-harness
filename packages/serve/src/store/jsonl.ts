/**
 * JSONL 存储的公共原语：id 白名单、目录创建、逐行读取与追加。
 *
 * 单用户单机场景刻意保持极简：没有事务、租约或幂等层。
 * 追加写用「单行 JSON + 换行」一次 `appendFile` 完成，保证文件始终可 `cat`；
 * 进程崩溃最多留下最后一行不完整 JSON，读取侧统一跳过损坏行。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** 文件/会话 id 白名单：禁止 `../`、`/` 与 `.` 逃逸到数据目录之外。 */
const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 校验存储 id 是否安全。
 *
 * @param id 会话 / run / conversation id。
 * @returns 符合白名单时返回 true。
 */
export function isValidStoreId(id: string): boolean {
  return STORE_ID_PATTERN.test(id);
}

/**
 * 校验并返回 id；非法时抛出结构化错误，避免把路径拼接漏洞带到文件系统边界。
 *
 * @param id 待校验 id。
 * @returns 原 id。
 */
export function assertStoreId(id: string): string {
  if (!isValidStoreId(id)) {
    throw new Error(`非法存储 id：${id}（仅允许字母、数字、下划线、连字符）`);
  }
  return id;
}

/**
 * 读取 JSONL 文件并逐行解析；文件不存在返回空数组，损坏行与空行跳过。
 *
 * @param filePath JSONL 文件路径。
 * @returns 解析成功的行值（保持文件顺序）。
 */
export async function readJsonlLines(filePath: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 崩溃可能留下半行 JSON；单行损坏不应毁掉整个读模型。
    }
  }
  return rows;
}

/**
 * 追加一行 JSON（自动补换行）。调用方负责保证父目录已创建。
 *
 * @param filePath 目标文件。
 * @param value 可 JSON 序列化的值。
 */
export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

/**
 * 确保目录存在。
 *
 * @param dir 目录路径。
 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * 返回当前时间的 ISO 字符串；集中一处便于测试替换时钟。
 *
 * @returns ISO 时间。
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 按父目录 + 白名单 id 计算 `.jsonl` 文件路径。
 *
 * @param dir 数据目录。
 * @param id 白名单 id。
 * @returns 文件绝对路径。
 */
export function jsonlPath(dir: string, id: string): string {
  return path.join(dir, `${assertStoreId(id)}.jsonl`);
}

/**
 * 串行化同一文件的写入：前一次写入完成后才执行下一次，避免 appendFile 交错。
 *
 * @param queues 每个文件的 Promise 链。
 * @param key 文件路径或 conversation id。
 * @param task 实际写入逻辑。
 * @returns 本次写入完成的 Promise（错误原样抛给调用方）。
 */
export async function serializedWrite<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(task);
  // 队列链只关心「前一次已结束」，吞掉错误避免一次失败阻塞后续写入。
  queues.set(key, current.then(() => undefined, () => undefined));
  return current;
}
