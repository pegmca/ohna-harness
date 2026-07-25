import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { withTransaction } from "./postgres.js";

const { Pool } = pg;

export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * 顺序执行目录内的 SQL migration，并在同一事务中记录执行结果。
 *
 * migration 文件名会进入安全错误消息，便于定位失败脚本；连接串和原始数据库错误不会拼入消息。
 *
 * @param pool 执行 migration 的 PostgreSQL 连接池。
 * @param migrationsDir migration 文件目录。
 * @returns migration 完成 Promise。
 */
export async function runMigrations(pool: pg.Pool, migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<void> {
  await pool.query(
    `create table if not exists __aiagent_migrations(
       name text primary key,
       applied_at timestamptz not null default now()
     );
     comment on column __aiagent_migrations.name is '已执行的 migration 文件名';
     comment on column __aiagent_migrations.applied_at is 'migration 成功提交时间'`
  );
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await pool.query("select 1 from __aiagent_migrations where name=$1", [file]);
    if (applied.rowCount) continue;
    try {
      await withTransaction(pool, async (client) => {
        await client.query(await readFile(join(migrationsDir, file), "utf8"));
        await client.query("insert into __aiagent_migrations(name) values ($1)", [file]);
      });
    } catch (cause) {
      throw new MigrationError(file, cause);
    }
  }
}

/** migration 失败的安全错误；公开消息只包含文件名，内部 cause 用于日志诊断。 */
export class MigrationError extends Error {
  readonly migrationFile: string;

  /**
   * @param migrationFile 失败的 migration 文件名。
   * @param cause 数据库返回的内部错误，不应序列化到 UI。
   */
  constructor(migrationFile: string, cause: unknown) {
    super(`Migration failed: ${migrationFile}`, { cause });
    this.name = "MigrationError";
    this.migrationFile = migrationFile;
  }
}

/**
 * 使用环境变量中的连接串执行仓库 migration。
 *
 * @returns migration 完成 Promise。
 */
async function migrateFromEnvironment(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrateFromEnvironment();
}
