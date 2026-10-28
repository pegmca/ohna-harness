import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { GoldenStudioError } from "./errors.js";
import type { WorkspaceConfig } from "./workspace.js";
import { assertContainedPath } from "./workspace.js";

/**
 * 把源文件复制到工作区备份目录，并返回唯一备份路径。
 *
 * 文件名同时包含 UTC 时间戳与随机片段，因此同一毫秒、同一标签的连续备份
 * 也不会互相覆盖。源文件在复制前必须已被包含在备份根或工作区根中。
 *
 * @param config 当前工作区配置。
 * @param sourcePath 要备份的文件路径。
 * @param label 便于识别的稳定标签。
 * @returns 创建成功的备份文件绝对路径。
 * @throws {WorkspaceError} 源文件或备份目标越界时抛出。
 * @throws {GoldenStudioError} 源文件不可读或复制失败时抛出 backup_failed。
 */
export async function backupFile(
  config: WorkspaceConfig,
  sourcePath: string,
  label: string
): Promise<string> {
  const source = isAbsolute(sourcePath)
    ? resolve(sourcePath)
    : resolve(config.workspaceRoot, sourcePath);
  assertContainedPath(config.workspaceRoot, source);
  assertContainedPath(config.workspaceRoot, config.backupRoot);
  await mkdir(config.backupRoot, { recursive: true });

  const safeLabel = normalizeLabel(label);
  const extension = extname(source);
  const stem = basename(source, extension);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(
    config.backupRoot,
    `${stem}.${safeLabel}.${timestamp}.${randomUUID()}${extension}`
  );
  assertContainedPath(config.workspaceRoot, destination);

  try {
    await copyFile(source, destination, 1);
  } catch (error) {
    throw new GoldenStudioError(
      "backup_failed",
      `Failed to back up ${source}.`,
      { sourcePath: source, destination },
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
