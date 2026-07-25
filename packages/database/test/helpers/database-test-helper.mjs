import pg from "pg";

const { Pool } = pg;
const TEST_SCHEMA_PREFIX = "aiagent_test_";

/**
 * 校验集成测试连接串不会指向开发数据库。
 *
 * @param {string | undefined} testDatabaseUrl 独立测试数据库连接串。
 * @param {string | undefined} developmentDatabaseUrl 开发数据库连接串。
 * @returns {URL} 已解析的测试数据库 URL。
 */
export function assertSafeTestDatabaseUrl(testDatabaseUrl, developmentDatabaseUrl) {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests.");
  const testUrl = new URL(testDatabaseUrl);
  const testDatabaseName = databaseName(testUrl);
  if (!testDatabaseName) throw new Error("TEST_DATABASE_URL must include an explicit database name.");
  if (developmentDatabaseUrl) {
    const developmentName = databaseName(new URL(developmentDatabaseUrl));
    if (testDatabaseName === developmentName) {
      throw new Error("TEST_DATABASE_URL must use a different database name from DATABASE_URL.");
    }
  }
  return testUrl;
}

/**
 * 创建仅作用于唯一 schema 的测试上下文。
 *
 * @param {string} testDatabaseUrl 独立测试数据库连接串。
 * @param {string | undefined} developmentDatabaseUrl 开发数据库连接串。
 * @returns {Promise<{pool: pg.Pool, schema: string, cleanup: () => Promise<void>}>} 测试上下文。
 */
export async function createDatabaseTestContext(testDatabaseUrl, developmentDatabaseUrl) {
  assertSafeTestDatabaseUrl(testDatabaseUrl, developmentDatabaseUrl);
  const schema = `${TEST_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  await adminPool.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 2, options: `-c search_path=${schema}` });
  return {
    pool,
    schema,
    async cleanup() {
      if (!schema.startsWith(TEST_SCHEMA_PREFIX)) throw new Error("Refusing to clean an unmanaged test schema.");
      await pool.end();
      await adminPool.query(`drop schema "${schema}" cascade`);
      await adminPool.end();
    }
  };
}

/** @param {URL} url PostgreSQL URL。 @returns {string} 数据库名。 */
function databaseName(url) {
  return decodeURIComponent(url.pathname.replace(/^\//, "")).replace(/\/$/, "");
}
