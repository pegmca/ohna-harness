/**
 * 数据目录单写者锁（进程租约）。
 *
 * 桌面 runtime 是唯一对 `dataDir` 做写入的进程：启动时用「原子排他创建」锁文件
 * 阻止第二个 writer 同时打开同一目录（spec §8.1）。锁文件残留必须**阻断**启动，
 * 而非被自动绕过——残留意味着上一次进程异常退出未释放租约，静默绕过会让两个
 * writer 同时写 JSONL 造成数据损坏。释放由 `release()` 显式删除锁文件完成。
 */
import { open, unlink } from "node:fs/promises";
import { RuntimeError } from "../errors.js";

/** 锁文件名（放在 dataDir 根，与子目录隔离）。 */
export const LOCK_FILE_NAME = "ohna-runtime.lock";

/** acquireDataDirLock 返回的句柄。 */
export interface DataDirLock {
  /** 释放租约：删除锁文件。 */
  release(): Promise<void>;
}

/**
 * 获取 dataDir 单写者锁。
 *
 * 用 `fs.open(path, "wx")` 做原子排他创建：文件不存在时才创建成功，已存在（残留锁
 * 或另一个 writer）则抛 `EEXIST`。命中残留锁时归一为结构化 `RuntimeError`
 *（`runtime_unavailable` / `conflict`），绝不绕过。
 *
 * @param dataDir 数据目录根。
 * @returns 锁句柄；调用方在 `shutdown()` 时调用 `release()` 释放。
 */
export async function acquireDataDirLock(dataDir: string): Promise<DataDirLock> {
  const lockPath = `${dataDir}/${LOCK_FILE_NAME}`;
  try {
    const handle = await open(lockPath, "wx");
    await handle.close();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // 目录还不存在：先建目录再原子创建锁文件。
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dataDir, { recursive: true });
      try {
        const handle = await open(lockPath, "wx");
        await handle.close();
      } catch (retry) {
        throw toLockError(retry, lockPath);
      }
    } else {
      throw toLockError(error, lockPath);
    }
  }

  return {
    async release(): Promise<void> {
      await unlink(lockPath);
    }
  };
}

/**
 * 把底层 `fs` 错误收敛为结构化锁错误。
 *
 * `EEXIST`（锁已存在：残留锁或并发 writer）与 `EACCES` 归一到
 * `runtime_unavailable` / `conflict`；其余按 `internal_error` 透出，保留原始消息。
 *
 * @param error 底层 fs 错误。
 * @param lockPath 锁文件绝对路径（用于细节）。
 * @returns 结构化 RuntimeError。
 */
function toLockError(error: unknown, lockPath: string): RuntimeError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") {
    return new RuntimeError(
      "conflict",
      "数据目录已被另一个 ohna 进程占用；残留锁会阻断启动，请先结束旧进程或清理锁文件。",
      { lockPath, reason: "lock_exists" }
    );
  }
  if (code === "EACCES") {
    return new RuntimeError(
      "runtime_unavailable",
      "数据目录锁文件无权访问，无法获取写者租约。",
      { lockPath, reason: "lock_no_permission" }
    );
  }
  throw new RuntimeError(
    "internal_error",
    error instanceof Error ? error.message : String(error),
    { lockPath }
  );
}
