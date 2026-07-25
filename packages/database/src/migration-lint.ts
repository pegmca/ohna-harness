const CREATE_TABLE_PATTERN = /create\s+table(?:\s+if\s+not\s+exists)?\s+([\w."-]+)\s*\(([\s\S]*?)\);/gi;
const COLUMN_PATTERN = /^\s*"?([a-z_][a-z0-9_]*)"?\s+/i;
const TABLE_CONSTRAINT_PATTERN = /^(constraint|primary|unique|check|foreign|exclude)\b/i;

export interface MigrationCommentIssue {
  table: string;
  column: string;
}

/**
 * 检查 SQL 文件中新建表的每一列是否在同一文件具有中文 COMMENT。
 *
 * 该检查面向项目约定的直白 migration SQL，不承担完整 SQL parser 的职责。
 *
 * @param sql 单个 migration 文件内容。
 * @returns 缺少合规中文注释的表列列表。
 */
export function findMissingColumnComments(sql: string): MigrationCommentIssue[] {
  const issues: MigrationCommentIssue[] = [];
  for (const match of sql.matchAll(CREATE_TABLE_PATTERN)) {
    const table = normalizeIdentifier(match[1]);
    for (const definition of splitTopLevel(match[2])) {
      const trimmed = definition.trim();
      if (!trimmed || TABLE_CONSTRAINT_PATTERN.test(trimmed)) continue;
      const columnMatch = trimmed.match(COLUMN_PATTERN);
      if (!columnMatch) continue;
      const column = columnMatch[1];
      const commentPattern = new RegExp(
        `comment\\s+on\\s+column\\s+(?:[\\w\"-]+\\.)?\"?${escapeRegExp(table)}\"?\\.\"?${escapeRegExp(column)}\"?\\s+is\\s+'[^']*[\\u3400-\\u9fff][^']*'`,
        "i"
      );
      if (!commentPattern.test(sql)) issues.push({ table, column });
    }
  }
  return issues;
}

/**
 * 按顶层逗号拆分列定义，避免误拆函数参数和约束表达式。
 *
 * @param body CREATE TABLE 括号内文本。
 * @returns 顶层定义列表。
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** @param value SQL 标识符。 @returns 去除 schema 与引号后的表名。 */
function normalizeIdentifier(value: string): string {
  return value.split(".").at(-1)?.replaceAll('"', "") ?? value;
}

/** @param value 正则文本。 @returns 可安全插入正则的文本。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
