/** 生成物相对于作者集的可用状态。 */
export type GeneratedFreshness = "fresh" | "stale" | "missing";

/** 文件时间戳在纳秒精度下的最小比较契约。 */
export interface FileTimestamp {
  mtimeMs: number;
  mtimeNs?: bigint;
}

/**
 * 比较作者集与生成物修改时间。
 *
 * 生成物与作者集同时刻或更新均视为 fresh；只有作者集更新才为 stale。
 *
 * @param golden 作者集时间戳；不存在时为 undefined。
 * @param generated 生成物时间戳；不存在时为 undefined。
 * @returns 生成物相对作者集的可用状态。
 */
export function classifyGeneratedFreshness(
  golden: FileTimestamp | undefined,
  generated: FileTimestamp | undefined
): GeneratedFreshness {
  if (!generated) return "missing";
  if (!golden) return "fresh";
  return compareTimestamp(generated, golden) >= 0 ? "fresh" : "stale";
}

/**
 * 优先以纳秒时间比较，运行环境无 bigint 精度时回退毫秒。
 *
 * @param left 左侧时间戳。
 * @param right 右侧时间戳。
 * @returns 负数、0、正数分别表示 left 早于、等于、晚于 right。
 */
function compareTimestamp(left: FileTimestamp, right: FileTimestamp): number {
  if (left.mtimeNs !== undefined && right.mtimeNs !== undefined) {
    return left.mtimeNs < right.mtimeNs ? -1 : left.mtimeNs > right.mtimeNs ? 1 : 0;
  }
  return left.mtimeMs - right.mtimeMs;
}
