import defaultFs from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { GoldenStudioError } from "./errors.js";
import type { WorkspaceConfig } from "./workspace.js";
import { assertContainedPath } from "./workspace.js";

/** 原子备份所需的文件系统最小端口；生产默认值不暴露给业务调用方。 */
interface BackupFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  open(
    path: string,
    flags: string,
    mode: number
  ): Promise<{
    writeFile(content: string | Buffer): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  readFile(path: string): Promise<Buffer>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

/**
 * 把源文件完整写入隐藏临时文件，再原子替换为唯一备份路径。
 *
 * 文件名同时包含 UTC 时间戳与随机片段，因此同一毫秒、同一标签的连续备份
 * 也不会互相覆盖。源文件在复制前必须已被包含在备份根或工作区根中。
 *
 * @param config 当前工作区配置。
 * @param sourcePath 要备份的文件路径。
 * @param label 便于识别的稳定标签。
 * @param fs 测试可注入的文件系统端口；生产忽略该参数。
 * @returns 创建成功的备份文件绝对路径。
 * @throws {WorkspaceError} 源文件或备份目标越界时抛出。
 * @throws {GoldenStudioError} 源文件不可读或复制失败时抛出 backup_failed。
 */
export async function backupFile(
  config: WorkspaceConfig,
  sourcePath: string,
  label: string,
  fs: BackupFs = defaultFs
): Promise<string> {
  const source = isAbsolute(sourcePath)
    ? resolve(sourcePath)
    : resolve(config.workspaceRoot, sourcePath);
  assertContainedPath(config.workspaceRoot, source);
  assertContainedPath(config.workspaceRoot, config.backupRoot);
  try {
    await fs.mkdir(config.backupRoot, { recursive: true });
  } catch (error) {
    throw new GoldenStudioError(
      "backup_failed",
      `Failed to prepare backup directory ${config.backupRoot}.`,
      { backupRoot: config.backupRoot },
      error
    );
  }

  const safeLabel = normalizeLabel(label);
  const extension = extname(source);
  const stem = basename(source, extension);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(
    config.backupRoot,
    `${stem}.${safeLabel}.${timestamp}.${randomUUID()}${extension}`
  );
  assertContainedPath(config.workspaceRoot, destination);
  const temporaryPath = join(
    config.backupRoot,
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  assertContainedPath(config.workspaceRoot, temporaryPath);
  let handle: Awaited<ReturnType<BackupFs["open"]>> | undefined;

  try {
    const content = await fs.readFile(source);
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await Promise.resolve()
      .then(() => fs.rm(temporaryPath, { force: true }))
      .catch(() => undefined);
    throw new GoldenStudioError(
      "backup_failed",
      `Failed to back up ${source}.`,
      { sourcePath: source, destination, temporaryPath },
      error
    );
  }

  return destination;
}

/**
 * 把任意标签收敛为可安全嵌入文件名的单段文本。
 *
 * @param label 调用方提供的展示标签。
 * @returns 不含路径与保留符号的标签。
 */
function normalizeLabel(label: string): string {
  const normalized = label
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "backup";
}
