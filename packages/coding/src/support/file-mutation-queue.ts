/**
 * 文件写串行化队列（ported from pi (badlogic/packages/coding-agent)，MIT，Copyright (c) 2025 Mario Zechner）。
 *
 * Agent 在一轮里可能并行下发多个写同一文件的动作（例如 write 后又 edit）。若不加串行化，
 * 「读旧内容 → 改 → 写回」的竞态会静默丢更新。这里按**realpath**做键串行化：
 * 同一物理文件（软链指向同一目标也算同一文件）排队执行，不同文件仍然并行。
 */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** key → 该文件上正在执行的尾任务 Promise。 */
const fileMutationQueues = new Map<string, Promise<void>>();
/** 「计算 key」这一步本身也要串行，避免两个并发调用同时看到空队列而双双插入。 */
let registrationQueue = Promise.resolve();

/**
 * 判断错误是否为「路径不存在」，用于把新建文件的兜底 key 退化为解析后的路径。
 *
 * @param error 任意异常对象。
 * @returns 为 ENOENT / ENOTDIR 时返回 true。
 */
function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * 计算写队列的 key：优先 realpath（消解软链），文件尚不存在时退化为解析后的绝对路径。
 *
 * @param filePath 目标文件路径。
 * @returns 串行化 key。
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  try {
    return await realpath(resolvedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return resolvedPath;
    }
    throw error;
  }
}

/**
 * 在全局「单文件写锁」下执行 fn。
 *
 * @param filePathOrFn 目标文件路径（推荐），或直接传任务函数（此时退化为全局串行，主要用于编排多个文件写入的复合操作）。
 * @param maybeFn 任务函数；第一个参数给文件路径时必填。
 * @returns fn 的返回值。
 * @template T fn 的返回类型。
 */
export async function withFileMutationQueue<T>(
  filePathOrFn: string | (() => Promise<T>),
  maybeFn?: () => Promise<T>,
): Promise<T> {
  const filePath = typeof filePathOrFn === "string" ? filePathOrFn : undefined;
  const fn = typeof filePathOrFn === "function" ? filePathOrFn : maybeFn;
  if (!fn) {
    throw new Error("withFileMutationQueue requires a task function");
  }

  const registration = registrationQueue.then(async () => {
    const key = filePath ? await getMutationQueueKey(filePath) : "*";
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext };
  });
  // 无论注册成功与否，后续注册不应被前一次失败阻塞
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
