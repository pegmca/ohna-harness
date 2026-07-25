import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStorage, ArtifactStorageWriteResult } from "./persistence.js";

const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f-]{36}\.pdf$/;

/**
 * 创建本地 PDF storage adapter。
 *
 * 随机 key 完全由服务端产生；临时文件与目标文件位于同一目录，确保 rename 保持原子性。
 *
 * @param rootDir composition root 配置的专用存储根目录。
 * @returns 本地 ArtifactStorage。
 */
export function createLocalArtifactStorage(rootDir: string): ArtifactStorage {
  if (!rootDir.trim()) throw new Error("ARTIFACT_STORAGE_ROOT is required.");

  return {
    async writePdf(bytes): Promise<ArtifactStorageWriteResult> {
      const id = randomUUID();
      const shard = id.slice(0, 2);
      const key = `${shard}/${id}.pdf`;
      const directory = join(rootDir, shard);
      const target = join(directory, `${id}.pdf`);
      const temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw new Error("Artifact PDF storage write failed.", { cause: error });
      }
      return {
        provider: "local",
        key,
        sizeBytes: bytes.byteLength,
        checksumSha256: createHash("sha256").update(bytes).digest("hex")
      };
    },
    async readPdf(key): Promise<Uint8Array> {
      assertStorageKey(key);
      try {
        return await readFile(join(rootDir, key));
      } catch (error) {
        throw new Error("Artifact PDF storage read failed.", { cause: error });
      }
    }
  };
}

/**
 * 拒绝路径穿越、绝对路径和控制字符，只接受 adapter 自己生成的 key。
 *
 * @param key 待校验 storage key。
 * @returns 校验通过时无返回值。
 */
export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key) || key.includes("..") || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("Invalid artifact storage key.");
  }
}
