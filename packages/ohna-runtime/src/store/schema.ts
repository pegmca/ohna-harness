/**
 * JSONL 行级 schema 版本与占位校验。
 *
 * Task 10 在此落地版本校验：读取侧用 `isCompatibleSchema`（按声明版本判断能否被当前
 * `SCHEMA_VERSION` 读取），不兼容的旧格式 run 在读取时被隔离（返回无 meta），不进入
 * 读模型；不做旧格式迁移逻辑（legacy `~/.ohna` 由计划 Step 5 单独删除）。
 */

/** 数据格式版本号；首版为 1。升级时递增并在 Task 10 接线迁移逻辑。 */
export const SCHEMA_VERSION = 1 as const;

/**
 * 占位行校验：判定一行 JSONL 是否声明了与当前 SCHEMA_VERSION 一致的 schema 版本。
 *
 * 仅用于「写入侧」自检：确认本进程写出的行带的是当前版本号。读取侧兼容性判定请使用
 * `isCompatibleSchema`（按「声明版本 + 兼容谓词」判断，而非要求字节相等）。
 *
 * @param value 解析后的 JSON 行值。
 * @returns 声明版本一致时返回 true；非对象、缺字段或版本不符返回 false。
 */
export function schemaLine(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.schema !== "number" || !Number.isInteger(record.schema)) return false;
  return record.schema === SCHEMA_VERSION;
}

/**
 * 取一行 JSONL 声明的数据格式版本号；无 `schema` 字段或类型非法时返回 undefined
 * （视为「未声明版本」的旧格式，由调用方按兼容性策略处理）。
 *
 * @param value 解析后的 JSON 行值。
 * @returns 声明版本号，或 undefined（未声明）。
 */
export function declaredSchemaVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.schema !== "number" || !Number.isInteger(record.schema)) return undefined;
  return record.schema;
}

/**
 * 判断一个「已声明版本号」是否能被当前 `SCHEMA_VERSION` 读取。
 *
 * 首版兼容性规则：只有恰好等于 `SCHEMA_VERSION` 才兼容（不做向后/向前兼容的泛化，
 * 保持单一事实源，避免隐式降级掩盖数据格式不匹配）。未来升级时在**此处**扩展谓词
 * （例如允许 `[SCHEMA_VERSION - 1, SCHEMA_VERSION]` 区间），读取侧无需改动。
 *
 * 注意：`undefined`（未声明 `schema` 字段）视为兼容——它表示「早于 schema 字段的
 * 版本 1 文件」，而非「声明了不兼容版本」。隔离只针对**显式声明**的不兼容版本
 * （spec §8.3：「若 meta 行声明了不兼容的 schema 版本」才隔离）。
 *
 * @param version 行首 meta 声明的 schema 版本号（undefined 视为不兼容）。
 * @returns 兼容返回 true；未声明或版本不符返回 false。
 */
export function isCompatibleSchema(version: number | undefined): boolean {
  // 未声明（undefined）：视为兼容的版本 1 文件。
  if (version === undefined) return true;
  // 显式声明：必须恰好等于当前版本才兼容。
  return version === SCHEMA_VERSION;
}
