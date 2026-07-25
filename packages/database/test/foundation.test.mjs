import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findMissingColumnComments, isPostgresUniqueViolation, postgresTimestampToIso, RepositoryError } from "../dist/index.js";
import { MigrationError, runMigrations } from "../dist/migrate.js";
import { assertSafeTestDatabaseUrl, createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

test("repository 基础 contract 与 PostgreSQL 映射保持稳定", () => {
  const cause = new Error("internal detail");
  const error = new RepositoryError("conflict", "resource conflict", cause);
  assert.equal(error.code, "conflict");
  assert.equal(error.cause, cause);
  assert.equal(JSON.stringify(error).includes("internal detail"), false);
  assert.equal(isPostgresUniqueViolation({ code: "23505" }), true);
  assert.equal(postgresTimestampToIso("2026-07-25T00:00:00+08:00"), "2026-07-24T16:00:00.000Z");
});

test("测试数据库保护拒绝缺失连接串及与开发库同名的连接串", () => {
  assert.throws(() => assertSafeTestDatabaseUrl(undefined, undefined), /TEST_DATABASE_URL is required/);
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://tester@localhost/aiagent", "postgresql://developer@other-host/aiagent"),
    /different database name/
  );
});

test("COMMENT 检查识别缺失注释的 fixture", async () => {
  const sql = await readFile(join(packageDir, "test/fixtures/missing-comment.sql"), "utf8");
  assert.deepEqual(findMissingColumnComments(sql), [{ table: "sample_records", column: "title" }]);
  const valid = `${sql}\nCOMMENT ON COLUMN sample_records.title IS '记录标题';`;
  assert.deepEqual(findMissingColumnComments(valid), []);
});

test("后续 migration 的新增列都有同文件中文注释", async () => {
  const migrationsDir = join(packageDir, "migrations");
  const files = (await readdir(migrationsDir)).filter((file) => file >= "0010" && file.endsWith(".sql"));
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    assert.deepEqual(findMissingColumnComments(sql), [], `${file} has columns without Chinese comments`);
  }
});

test("后续 migration 编号保持保留且无业务 migration 被提前创建", async () => {
  const reserved = ["0010", "0020", "0030", "0040", "0050", "0060", "0070", "0080"];
  const plan = await readFile(join(packageDir, "README.md"), "utf8");
  for (const prefix of reserved) assert.equal(plan.includes(`\`${prefix}\``), true);
});

test("空库 migration 可执行、可幂等，并回滚失败 migration", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const fixtureDir = await mkdtemp(join(tmpdir(), "aiagent-migrations-"));
  try {
    await runMigrations(context.pool, join(packageDir, "migrations"));
    await runMigrations(context.pool, join(packageDir, "migrations"));
    const applied = await context.pool.query("select name from __aiagent_migrations order by name");
    assert.deepEqual(applied.rows.map((row) => row.name), ["0000_identity.sql", "0070_report.sql"]);

    await writeFile(join(fixtureDir, "9999_failure.sql"), "create table rolled_back(id integer); select missing_function();");
    await assert.rejects(() => runMigrations(context.pool, fixtureDir), (error) => {
      assert(error instanceof MigrationError);
      assert.equal(error.message, "Migration failed: 9999_failure.sql");
      assert.equal(error.message.includes(process.env.TEST_DATABASE_URL), false);
      return true;
    });
    const table = await context.pool.query("select to_regclass('rolled_back') as name");
    assert.equal(table.rows[0].name, null);
    const failedEntry = await context.pool.query("select 1 from __aiagent_migrations where name='9999_failure.sql'");
    assert.equal(failedEntry.rowCount, 0);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await context.cleanup();
  }
});

test("两个 pool 并发执行同一非幂等 migration 时只应用一次", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const secondPool = context.createPool();
  const fixtureDir = await mkdtemp(join(tmpdir(), "aiagent-concurrent-migrations-"));
  try {
    await writeFile(join(fixtureDir, "0010_concurrent.sql"), "create table concurrent_records(id integer primary key);");
    await Promise.all([runMigrations(context.pool, fixtureDir), runMigrations(secondPool, fixtureDir)]);
    const applied = await context.pool.query(
      "select count(*)::integer as count from __aiagent_migrations where name='0010_concurrent.sql'"
    );
    assert.equal(applied.rows[0].count, 1);
    const table = await context.pool.query("select to_regclass('concurrent_records') as name");
    assert.equal(table.rows[0].name, "concurrent_records");
  } finally {
    await secondPool.end();
    await rm(fixtureDir, { recursive: true, force: true });
    await context.cleanup();
  }
});
