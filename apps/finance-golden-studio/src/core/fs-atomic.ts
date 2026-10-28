import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { GoldenStudioError } from "./errors.js";

/**
 * 通过同目录临时文件与 rename 原子替换目标文件。
 *
 * 内容完整写入并同步到临时文件后才替换目标；任一步失败都会清理临时文件，
 * 已有目标保持原样。同目录 rename 保证普通本地文件系统上的原子可见性。
 *
 * @param path 要替换的绝对或相对目标路径。
 * @param content 完整 UTF-8 文本内容。
 * @throws {GoldenStudioError} 写入、同步或替换失败时抛出 atomic_write_failed。
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new GoldenStudioError(
      "atomic_write_failed",
      `Failed to atomically write ${path}.`,
      { path },
      error
    );
  }
}
