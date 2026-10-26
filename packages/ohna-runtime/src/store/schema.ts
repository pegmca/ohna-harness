/**
 * JSONL 行级 schema 版本与占位校验。
 *
 * Task 2 只建立常量与最小校验入口；真正的行级 schema 校验接线（按 store 类型分别校验
 * `conversation_meta` / `session` / `run_meta` / `LinearMessageDto` / `RunStreamEventDtoV2`）
 * 由 Task 10 完成。此处 `schemaLine` 只做「对象且 `schema` 字段为数字且等于 SCHEMA_VERSION」
 * 的最小占位判定，供 Task 10 在读取侧统一接入。
 */

/** 数据格式版本号；首版为 1。升级时递增并在 Task 10 接线迁移逻辑。 */
export const SCHEMA_VERSION = 1 as const;

/**
 * 占位行校验：判定一行 JSONL 是否声明了与当前 SCHEMA_VERSION 一致的 schema 版本。
 *
 * 当前只做最小形状校验（对象 + 数字 `schema` 字段 + 值等于 SCHEMA_VERSION），
 * 不做按 store 类型的字段级校验。Task 10 会替换为按行类型分别校验的完整实现。
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
