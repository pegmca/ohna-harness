import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

/**
 * 顺序执行仓库内 SQL migration，并用 migration 名称保证幂等。
 *
 * @returns migration 完成 Promise。
 */
async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
  try {
    await pool.query("create table if not exists __aiagent_migrations(name text primary key, applied_at timestamptz not null default now())");
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const applied = await pool.query("select 1 from __aiagent_migrations where name=$1", [file]);
      if (applied.rowCount) continue;
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(await readFile(join(migrationsDir, file), "utf8"));
        await client.query("insert into __aiagent_migrations(name) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

await migrate();
