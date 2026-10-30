import type { MineCandidate } from "../../../core/types.js";

/** 浏览器候选文件解析结果。 */
export type CandidateFileResult =
  | { ok: true; candidates: MineCandidate[] }
  | { ok: false; message: string };

/**
 * 解析 CLI 同款 JSON 候选数组。
 *
 * @param text 用户选择的文件文本。
 * @returns 候选对象或可展示错误。
 */
export function parseCandidateFile(text: string): CandidateFileResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "候选文件必须包含合法的 JSON。" };
  }
  if (!Array.isArray(value) || !value.every(isRecord)) {
    return {
      ok: false,
      message: "候选文件必须包含对象数组。"
    };
  }
  return { ok: true, candidates: value as unknown as MineCandidate[] };
}

/**
 * 判断普通对象。
 *
 * @param value 候选文件条目。
 * @returns 非数组对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
