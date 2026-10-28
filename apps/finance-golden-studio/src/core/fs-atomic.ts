import defaultFs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { GoldenStudioError } from "./errors.js";

/** 原子写入所需的文件系统最小端口；生产默认值不暴露给业务调用方。 */
interface AtomicWriteFs {
  open(
    path: string,
    flags: string,
    mode: number
  ): Promise<{
    writeFile(content: string, encoding: BufferEncoding): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

/**
 * 通过同目录临时文件与 rename 原子替换目标文件。
 *
 * 内容完整写入并同步到临时文件后才替换目标；任一步失败都会清理临时文件，
 * 已有目标保持原样。同目录 rename 保证普通本地文件系统上的原子可见性。
 *
 * @param path 要替换的绝对或相对目标路径。
 * @param content 完整 UTF-8 文本内容。
 * @param fs 测试可注入的文件系统端口；生产忽略该参数。
 * @throws {GoldenStudioError} 写入、同步或替换失败时抛出 atomic_write_failed。
 */
export async function writeFileAtomic(
  path: string,
  content: string,
  fs: AtomicWriteFs = defaultFs
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<AtomicWriteFs["open"]>> | undefined;

  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new GoldenStudioError(
      "atomic_write_failed",
      `Failed to atomically write ${path}.`,
      { path },
      error
    );
  }
}
