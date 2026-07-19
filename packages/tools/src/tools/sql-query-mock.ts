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

const SQL_FORBIDDEN_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|replace|merge|grant|revoke|vacuum|attach|detach|copy|call|execute|exec|pragma|set|use|into|outfile|load_file|pg_read_file|dblink)\b/i;

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
      },
      reasonCode: readonly ? "SEC_SQL_APPROVAL_REQUIRED" : "SEC_SQL_READONLY_VIOLATION"
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
  const normalized = query.trim();
  if (!normalized || /--|\/\*|\*\//.test(normalized)) return false;
  const statements = splitSqlStatements(normalized);
  if (statements.length !== 1) return false;
  const statement = statements[0]?.trim() ?? "";
  if (!/^(select|with)\b/i.test(statement)) return false;
  if (SQL_FORBIDDEN_KEYWORDS.test(maskSqlLiterals(statement))) return false;
  return hasBalancedSqlSyntax(statement);
}

/** @param sql SQL 原文。 @returns 忽略字符串内分号后的非空语句。 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []; let current = ""; let quote: "'" | '"' | undefined;
  for (let index = 0; index < sql.length; index += 1) { const char = sql[index]; const next = sql[index + 1]; if (quote) { current += char; if (char === quote && next === quote) { current += next; index += 1; } else if (char === quote) quote = undefined; continue; } if (char === "'" || char === '"') { quote = char; current += char; } else if (char === ";") { if (current.trim()) statements.push(current); current = ""; } else current += char; }
  if (quote) return []; if (current.trim()) statements.push(current); return statements;
}

/** @param sql 单条 SQL。 @returns 将字符串字面量替换为空串后的文本。 */
function maskSqlLiterals(sql: string): string { return sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""'); }

/** @param sql 单条 SQL。 @returns 括号是否闭合。 */
function hasBalancedSqlSyntax(sql: string): boolean { let depth = 0; for (const char of maskSqlLiterals(sql)) { if (char === "(") depth += 1; if (char === ")") depth -= 1; if (depth < 0) return false; } return depth === 0; }
