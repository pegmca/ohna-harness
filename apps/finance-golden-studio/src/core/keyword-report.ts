import type {
  GoldenEvidence,
  GoldenDraftType,
  KeywordCaseSummary,
  KeywordDiagnostic,
  KeywordReachabilityResult,
  KeywordTypeSummary,
  KeywordValidationSummary
} from "./types.js";

/** 题型枚举校验集合；报告中的 type 只接受作者集已知题型。 */
const GOLDEN_TYPES = new Set<GoldenDraftType>([
  "numeric_fact",
  "definitional",
  "comparison",
  "multi_doc",
  "table",
  "unit_trap",
  "negative"
]);

/**
 * 从逐关键词诊断生成稳定汇总。
 *
 * byCase 与 byType 保持首次出现顺序，便于 CLI/UI 在不同运行间稳定展示；
 * 无 caseId 的底层结果仍计入总数，但不伪造 case 归属。
 *
 * @param results 已归属或底层关键词结果。
 * @returns 总数、可达数、失败数及 case/type 分组。
 */
export function createKeywordValidationSummary(
  results: readonly KeywordDiagnostic[]
): KeywordValidationSummary {
  const caseMap = new Map<string, KeywordCaseSummary>();
  const typeMap = new Map<GoldenDraftType, KeywordTypeSummary>();

  for (const result of results) {
    if (result.caseId) {
      const current = caseMap.get(result.caseId) ?? {
        caseId: result.caseId,
        ...(result.caseType ? { caseType: result.caseType } : {}),
        total: 0,
        reachable: 0,
        unreachable: 0
      };
      increment(current, result.reachable);
      caseMap.set(result.caseId, current);
    }
    if (result.caseType) {
      const current = typeMap.get(result.caseType) ?? {
        caseType: result.caseType,
        cases: 0,
        total: 0,
        reachable: 0,
        unreachable: 0
      };
      increment(current, result.reachable);
      typeMap.set(result.caseType, current);
    }
  }

  for (const summary of typeMap.values()) {
    summary.cases = new Set(
      results
        .filter((result) => result.caseType === summary.caseType && result.caseId)
        .map((result) => result.caseId)
    ).size;
  }

  const reachable = results.filter((result) => result.reachable).length;
  return {
    total: results.length,
    reachable,
    unreachable: results.length - reachable,
    byCase: [...caseMap.values()],
    byType: [...typeMap.values()]
  };
}

/**
 * 将已解析记录中的类型收窄为作者集题型。
 *
 * @param value 原始记录 type。
 * @returns 合法题型；否则 undefined。
 */
export function asGoldenDraftType(value: unknown): GoldenDraftType | undefined {
  return typeof value === "string" && GOLDEN_TYPES.has(value as GoldenDraftType)
    ? (value as GoldenDraftType)
    : undefined;
}

/**
 * 将底层关键词匹配结果归属到 author case 与 evidence 文档。
 *
 * @param record 作者记录。
 * @param evidence 可定位 evidence 及原数组索引。
 * @param resolveDocumentFilePath 按记录 resolution 解析 evidence 文件身份。
 * @param results 底层关键词匹配结果。
 * @returns 带稳定 case/type/index/evidence 归属的诊断。
 */
export function attributeKeywordResults(
  record: Record<string, unknown>,
  evidence: ReadonlyArray<{ value: GoldenEvidence; index: number }>,
  resolveDocumentFilePath: (evidence: GoldenEvidence) => string | undefined,
  results: readonly KeywordReachabilityResult[]
): KeywordDiagnostic[] {
  const id = typeof record.id === "string" ? record.id : undefined;
  const caseType = asGoldenDraftType(record.type);
  if (!id || !caseType || !Array.isArray(record.expected_keywords)) return [];
  const keywords = record.expected_keywords;
  return results.flatMap((result, resultIndex) => {
    const keywordIndex =
      keywords[resultIndex] === result.keyword
        ? resultIndex
        : keywords.findIndex((keyword) => keyword === result.keyword);
    if (keywordIndex < 0) return [];
    return [
      {
        ...result,
        caseId: id,
        caseType,
        keywordIndex,
        evidence: evidence.map(({ value, index }) => {
          const documentFilePath = resolveDocumentFilePath(value);
          return {
            evidenceIndex: index,
            ...(documentFilePath ? { documentFilePath } : {}),
            reachable: result.evidenceIndexes.includes(index)
          };
        })
      }
    ];
  });
}

/**
 * 累加一条关键词结果。
 *
 * @param summary case 或 type 计数。
 * @param reachable 关键词是否可达。
 */
function increment(
  summary: Pick<
    KeywordCaseSummary | KeywordTypeSummary,
    "total" | "reachable" | "unreachable"
  >,
  reachable: boolean
): void {
  summary.total += 1;
  if (reachable) summary.reachable += 1;
  else summary.unreachable += 1;
}
