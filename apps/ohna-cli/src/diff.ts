/**
 * 零依赖行级 diff：LCS（最长公共子序列）+ unified diff 格式化。
 *
 * 为什么自研而不引入 `diff` npm 包：CLI 只需要「行级 unified diff」这一个形状，
 * 引入一个完整 diff 库（含词级/patch 应用/合并策略）超出需要；LCS 的 O(n·m) DP
 * 在「写前预览」场景足够快（配合 2000 行的退化护栏，最坏 4M 格子仍在毫秒~十毫秒级）。
 *
 * 纯函数边界：本模块不做任何 IO 与终端输出，diff 的展示折叠（超 400 行省略中段）
 * 属于 render.ts 的展示策略。
 */

/** diff 行类型：上下文 / 新增 / 删除。 */
export type DiffLineType = "context" | "add" | "del";

/** 单条 diff 行。 */
export interface DiffLine {
  type: DiffLineType;
  /** 行文本（不含前缀符号与换行符）。 */
  text: string;
}

/** 退化护栏：行数超过该值时放弃 LCS，直接输出「整段删除 + 整段新增」。 */
const MAX_LCS_CELLS = 4_000_000;

/**
 * 把文本拆成行（容忍无结尾换行的最后一行；空文本视为 0 行）。
 *
 * @param text 原始文本。
 * @returns 行数组。
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // 以 \n 结尾时 split 会产生一个空尾行，去掉它（unified diff 不显示“空行”伪影）。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 计算两段文本的行级 diff（LCS 回溯）。
 *
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @returns context/add/del 序列，顺序即展示顺序。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 超大文件退化：LCS 的 O(n·m) 空间不可接受，且此时「逐行对齐」的信息价值很低。
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度；从后往前填表，回溯时优先产出删除再产出新增，
  // 使相邻的 -/+ 行保持「先删后加」的稳定顺序。
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: Uint32Array[] = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: "context", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      result.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    result.push({ type: "del", text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    result.push({ type: "add", text: b[j] });
    j += 1;
  }
  return result;
}

/**
 * 生成 unified diff 的 hunk 头：`@@ -a,b +c,d @@`。
 *
 * 遵循 unified diff 惯例：行数为 1 时省略 `,1`；行数为 0 时起始行记 0（`0,0`）。
 *
 * @param oldStart 旧文件起始行（1-based）。
 * @param oldCount 旧文件行数。
 * @param newStart 新文件起始行（1-based）。
 * @param newCount 新文件行数。
 * @returns hunk 头文本。
 */
function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  const left = oldCount === 1 ? String(oldStart) : `${oldStart},${oldCount}`;
  const right = newCount === 1 ? String(newStart) : `${newStart},${newCount}`;
  return `@@ -${left} +${right} @@`;
}

/**
 * 格式化为单 hunk 的 unified diff（全文件对比，不做上下文窗口折叠）。
 *
 * 空文件侧输出 `0,0`（标准行为：新文件全 `+`，删除文件全 `-`）。
 *
 * @param oldText 旧文本（新文件传空字符串）。
 * @param newText 新文本（删除文件传空字符串）。
 * @param label 可选标题行（如 `--- a/foo.ts` / `+++ b/foo.ts` 之上的说明）；不参与断言格式。
 * @returns unified diff 文本（不带结尾换行；无差异时返回空字符串）。
 */
export function formatUnifiedDiff(oldText: string, newText: string, label?: string): string {
  const lines = diffLines(oldText, newText);
  if (!lines.some((line) => line.type !== "context")) return "";

  const oldCount = lines.filter((line) => line.type !== "add").length;
  const newCount = lines.filter((line) => line.type !== "del").length;
  const header = hunkHeader(oldCount > 0 ? 1 : 0, oldCount, newCount > 0 ? 1 : 0, newCount);
  const body = lines.map((line) => {
    const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
    return `${prefix}${line.text}`;
  });
  const head = label ? [label] : [];
  return [...head, header, ...body].join("\n");
}
