import type pg from "pg";

/** 可参与事务的 PostgreSQL 连接池最小接口。 */
type TransactionPool = Pick<pg.Pool, "connect">;

/** PostgreSQL 查询结果中的时间表示。 */
export type PostgresTimestamp = Date | string;

/**
 * 把 PostgreSQL driver 返回的时间统一映射为传输层可用的 ISO 字符串。
 *
 * @param value PostgreSQL 时间值。
 * @returns UTC ISO 时间字符串。
 */
export function postgresTimestampToIso(value: PostgresTimestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 判断未知异常是否为 PostgreSQL 唯一约束冲突。
 *
 * @param error 待识别异常。
 * @returns 是否为 SQLSTATE 23505。
 */
export function isPostgresUniqueViolation(error: unknown): boolean {
  return hasPostgresCode(error, "23505");
}

/**
 * 在单个连接上执行事务，并保证异常路径尝试回滚。
 *
 * @template T 事务回调结果类型。
 * @param pool PostgreSQL 连接池。
 * @param operation 事务内执行的操作。
 * @returns 事务回调结果。
 */
export async function withTransaction<T>(
  pool: TransactionPool,
  operation: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 以不依赖 pg 异常类的方式识别 SQLSTATE。
 *
 * @param error 未知异常。
 * @param code 目标 SQLSTATE。
 * @returns 是否匹配。
 */
function hasPostgresCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
