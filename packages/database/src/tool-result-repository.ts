import type pg from "pg";
import { postgresTimestampToIso } from "./postgres.js";

/**
 * 写类工具结果去重存储（at-least-once 重排的副作用安全网）。
 *
 * 当前 recoverStale 是整 Run 重排（从 request_payload 重建上下文重新执行），
 * 一旦引入写类工具（发单/外呼/写库）at-least-once 重跑会重复副作用。
 * 本 store 按 (run_id, tool_call_id) 幂等落工具结果；恢复续跑时据此跳过已完成的写类工具，
 * 使重跑只补未完成的轮次，不再重复已落定的副作用。
 */
export interface ToolResultRecord {
  /** 所属 run 标识。 */
  runId: string;
  /** 单次工具调用 id（与 run_id 共同构成去重键）。 */
  toolCallId: string;
  /** 工具名称。 */
  toolName: string;
  /** 工具结构化结果。 */
  result: unknown;
  /** 写入时间。 */
  createdAt: string;
}

export interface ToolResultStore {
  /** 幂等写入工具结果（同键重复写入不报错，保留首次结果）。 */
  record(input: { runId: string; toolCallId: string; toolName: string; result: unknown }): Promise<void>;
  /** @returns 指定 (run_id, tool_call_id) 的已落结果；不存在时 undefined。 */
  get(runId: string, toolCallId: string): Promise<ToolResultRecord | undefined>;
  /** @returns 某 run 的全部已落工具结果（按写入序）。 */
  listByRun(runId: string): Promise<ToolResultRecord[]>;
}

/**
 * 创建 PostgreSQL 实现的写类工具结果去重存储。
 *
 * @param pool PostgreSQL 连接池。
 * @returns 工具结果去重存储。
 */
export function createPostgresToolResultStore(pool: pg.Pool): ToolResultStore {
  return {
    async record(input): Promise<void> {
      // 幂等 upsert：重复 tool_call_id 不报错，保留首次结果（不覆盖，避免续跑篡改已落定副作用）。
      await pool.query(
        `insert into tool_results(run_id, tool_call_id, tool_name, result, created_at)
           values ($1, $2, $3, $4, now())
           on conflict (run_id, tool_call_id) do nothing`,
        [input.runId, input.toolCallId, input.toolName, JSON.stringify(input.result)]
      );
    },
    async get(runId, toolCallId): Promise<ToolResultRecord | undefined> {
      const result = await pool.query<{
        run_id: string; tool_call_id: string; tool_name: string; result: unknown; created_at: Date | string;
      }>(
        "select run_id, tool_call_id, tool_name, result, created_at from tool_results where run_id=$1 and tool_call_id=$2",
        [runId, toolCallId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        result: row.result,
        createdAt: postgresTimestampToIso(row.created_at)
      };
    },
    async listByRun(runId): Promise<ToolResultRecord[]> {
      const result = await pool.query<{
        run_id: string; tool_call_id: string; tool_name: string; result: unknown; created_at: Date | string;
      }>(
        "select run_id, tool_call_id, tool_name, result, created_at from tool_results where run_id=$1 order by created_at, tool_call_id",
        [runId]
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        result: row.result,
        createdAt: postgresTimestampToIso(row.created_at)
      }));
    }
  };
}
