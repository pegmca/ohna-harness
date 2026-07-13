import { z } from "zod";
import type { Tool } from "../types.js";

export const sqlQueryMockInputSchema = z.object({
  query: z.string().min(1, "query is required")
});

export const sqlQueryMockOutputSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number()
});

export type SqlQueryMockInput = z.infer<typeof sqlQueryMockInputSchema>;
export type SqlQueryMockOutput = z.infer<typeof sqlQueryMockOutputSchema>;

const SQL_WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|replace|merge|grant|revoke|vacuum|attach|detach)\b/i;

export const sqlQueryMockTool: Tool<SqlQueryMockInput, SqlQueryMockOutput> = {
  name: "sql_query_mock",
  description: "Run a readonly SQL query against a stable mock research dataset.",
  permissionLevel: "needs_approval",
  inputSchema: sqlQueryMockInputSchema,
  outputSchema: sqlQueryMockOutputSchema,
  /**
   * SQL 第一版只允许只读 SELECT/WITH 查询；写操作直接 blocked，读查询仍需要人工确认。
   *
   * @param input SQL 查询输入。
   * @returns 权限判断和脱敏 SQL 预览。
   */
  evaluatePermission(input) {
    const readonly = isReadonlySql(input.query);

    return {
      permissionLevel: readonly ? "needs_approval" : "blocked",
      reason: readonly
        ? "SQL query is readonly but still requires human approval before execution."
        : "SQL query contains write or schema-changing keywords and is blocked by readonly policy.",
      inputPreview: {
        queryPreview: input.query.replace(/\s+/g, " ").trim().slice(0, 120),
        readonly
      }
    };
  },
  /**
   * 返回稳定 mock 查询结果；真实数据库接入前不执行外部 SQL。
   *
   * @param input SQL 查询输入。
   * @returns mock 行集。
   */
  execute(input) {
    return {
      columns: ["ticker", "metric", "value", "period"],
      rows: [
        {
          ticker: "000001.SZ",
          metric: "roe",
          value: 3.42,
          period: "2026Q1"
        }
      ],
      rowCount: 1
    };
  }
};

/**
 * 校验 SQL 是否属于只读查询。该启发式只覆盖学习阶段 demo，不替代数据库级只读账号。
 *
 * @param query 用户输入 SQL。
 * @returns 是否允许进入审批流程。
 */
export function isReadonlySql(query: string): boolean {
  const normalized = query.trim().replace(/;+\s*$/, "");
  const withoutComments = normalized.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, " ");

  if (!/^(select|with)\b/i.test(withoutComments.trim())) {
    return false;
  }

  return !SQL_WRITE_KEYWORDS.test(withoutComments);
}
