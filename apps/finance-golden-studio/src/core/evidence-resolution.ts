import type { ManifestRecord, ManifestTickerKey } from "./manifest.js";
import {
  manifestFilePathKey,
  manifestSemanticKey
} from "./manifest.js";
import type { GoldenEvidence } from "./types.js";

/** latest_by 的语义作用域；报告类型/期提供后不得跨到其他报告类型。 */
export type ManifestLatestScope = Pick<
  ManifestRecord,
  "ticker" | "report_type" | "period"
>;

/** 精确来源解析结果；不成功时绝不按 manifest 行顺序选择。 */
export type ManifestEvidenceResolution =
  | { kind: "resolved"; record: ManifestRecord }
  | {
      kind: "ambiguous";
      semantic: string;
      candidateFilePaths: string[];
      disambiguationField: "document_file_path";
    }
  | { kind: "not_found"; semantic: string }
  | {
      kind: "selector_not_found";
      filePath: string;
      normalizedFilePath: string;
    }
  | {
      kind: "selector_mismatch";
      filePath: string;
      semantic: string;
      recordSemantic: string;
    };

/** latest_by 文档解析结果；跨变体并列同样结构化返回。 */
export type ManifestLatestResolution =
  | { kind: "resolved"; record: ManifestRecord }
  | {
      kind: "ambiguous";
      scope: ManifestLatestScope;
      disclosureDate: string;
      candidateFilePaths: string[];
      disambiguationField: "resolution.variant";
    }
  | {
      kind: "not_found";
      scope: ManifestLatestScope;
      reason: "no_records" | "no_disclosure_date";
    }
  | { kind: "variant_not_found"; scope: ManifestLatestScope; variant: string };

/** 按文件身份、语义三元组与 ticker 预建的来源索引。 */
export interface ManifestIndex {
  records: readonly ManifestRecord[];
  byFilePath: ReadonlyMap<string, ManifestRecord>;
  bySemantic: ReadonlyMap<string, readonly ManifestRecord[]>;
  byTicker: ReadonlyMap<string, readonly ManifestRecord[]>;
  byVariantTicker: ReadonlyMap<string, readonly ManifestRecord[]>;
}

/**
 * 为 manifest 记录建立来源解析索引。
 *
 * `file_path` 是唯一身份，语义三元组仍保留为检索/筛选字段；
 * 同一三元组可以对应多个变体，因此按语义键保存记录数组。
 *
 * @param records 合法 manifest 记录。
 * @returns 不依赖记录行顺序的解析索引。
 */
export function createManifestIndex(
  records: readonly ManifestRecord[]
): ManifestIndex {
  const byFilePath = new Map<string, ManifestRecord>();
  const bySemantic = new Map<string, ManifestRecord[]>();
  const byTicker = new Map<string, ManifestRecord[]>();
  const byVariantTicker = new Map<string, ManifestRecord[]>();

  for (const record of records) {
    byFilePath.set(manifestFilePathKey(record.file_path), record);
    append(bySemantic, manifestSemanticKey(record), record);
    append(byTicker, record.ticker, record);
    if (record.variant !== undefined) {
      append(
        byVariantTicker,
        variantTickerKey({ ticker: record.ticker, variant: record.variant }),
        record
      );
    }
  }

  return {
    records,
    byFilePath,
    bySemantic,
    byTicker,
    byVariantTicker
  };
}

/**
 * 解析一条 evidence 的精确来源记录。
 *
 * 有 `document_file_path` 时优先按稳定文件身份解析并校验语义字段；
 * 无选择器时，语义三元组唯一才可解析，多条候选只返回结构化歧义。
 *
 * @param evidence 作者集证据引用。
 * @param index manifest 解析索引。
 * @returns 唯一记录或结构化失败原因。
 */
export function resolveEvidenceRecord(
  evidence: Pick<
    GoldenEvidence,
    "ticker" | "report_type" | "period" | "document_file_path"
  >,
  index: ManifestIndex
): ManifestEvidenceResolution {
  const semantic = manifestSemanticKey(evidence);
  const selector = evidence.document_file_path?.trim();
  if (selector) {
    const normalizedFilePath = manifestFilePathKey(selector);
    const record = index.byFilePath.get(normalizedFilePath);
    if (!record) {
      return {
        kind: "selector_not_found",
        filePath: selector,
        normalizedFilePath
      };
    }
    if (manifestSemanticKey(record) !== semantic) {
      return {
        kind: "selector_mismatch",
        filePath: selector,
        semantic,
        recordSemantic: manifestSemanticKey(record)
      };
    }
    return { kind: "resolved", record };
  }

  const candidates = index.bySemantic.get(semantic) ?? [];
  if (candidates.length === 0) {
    return { kind: "not_found", semantic };
  }
  if (candidates.length === 1) {
    return { kind: "resolved", record: candidates[0] };
  }
  return {
    kind: "ambiguous",
    semantic,
    candidateFilePaths: candidates.map((record) => record.file_path),
    disambiguationField: "document_file_path"
  };
}

/**
 * 按披露日期解析 latest_by 的唯一来源。
 *
 * 显式 variant 只在该变体内部比较；无 variant 时使用同 ticker、同
 * report_type/period 的记录。最大披露日并列只返回结构化歧义，不依赖
 * manifest 行顺序。
 *
 * @param index manifest 解析索引。
 * @param scopeOrTicker latest_by 的语义作用域；字符串形式仅兼容旧调用。
 * @param variant 可选 A/H 等显式变体类。
 * @returns 最新记录或结构化失败原因。
 */
export function resolveLatestManifestRecord(
  index: ManifestIndex,
  scopeOrTicker: ManifestLatestScope | string,
  variant?: string
): ManifestLatestResolution {
  const scope: ManifestLatestScope =
    typeof scopeOrTicker === "string"
      ? {
          ticker: scopeOrTicker,
          report_type: undefined as never,
          period: undefined as never
        }
      : scopeOrTicker;
  const semanticScope =
    scope.report_type !== undefined && scope.period !== undefined;
  if (variant !== undefined && variant.trim().length > 0) {
    const variantRecords = index.byVariantTicker.get(
      variantTickerKey({ ticker: scope.ticker, variant: variant.trim() })
    ) ?? [];
    const scopedVariants = semanticScope
      ? variantRecords.filter(
          (record) =>
            manifestSemanticKey(record) === manifestSemanticKey(scope)
        )
      : variantRecords;
    if (scopedVariants.length === 0) {
      return { kind: "variant_not_found", scope, variant };
    }
    return latestAmong(scope, scopedVariants);
  }

  const records = semanticScope
    ? index.bySemantic.get(manifestSemanticKey(scope)) ?? []
    : index.byTicker.get(scope.ticker) ?? [];
  if (records.length === 0) {
    return { kind: "not_found", scope, reason: "no_records" };
  }
  return latestAmong(scope, records);
}

/**
 * 在候选记录中选择 ISO 披露日最大且唯一的记录。
 *
 * @param scope 来源语义作用域。
 * @param records 候选记录。
 * @returns 唯一记录、并列歧义或缺少披露日期。
 */
function latestAmong(
  scope: ManifestLatestScope,
  records: readonly ManifestRecord[]
): ManifestLatestResolution {
  const dated = records.filter(
    (record): record is ManifestRecord & { disclosure_date: string } =>
      typeof record.disclosure_date === "string" &&
      record.disclosure_date.trim().length > 0
  );
  if (dated.length === 0) {
    return { kind: "not_found", scope, reason: "no_disclosure_date" };
  }
  const disclosureDate = dated.reduce(
    (maximum, record) =>
      record.disclosure_date > maximum ? record.disclosure_date : maximum,
    dated[0].disclosure_date
  );
  const newest = dated.filter(
    (record) => record.disclosure_date === disclosureDate
  );
  if (newest.length > 1) {
    return {
      kind: "ambiguous",
      scope,
      disclosureDate,
      candidateFilePaths: newest.map((record) => record.file_path),
      disambiguationField: "resolution.variant"
    };
  }
  return { kind: "resolved", record: newest[0] };
}

/**
 * 向 map 数组追加一条记录。
 *
 * @param target 分组 map。
 * @param key 分组键。
 * @param record 待追加记录。
 */
function append(
  target: Map<string, ManifestRecord[]>,
  key: string,
  record: ManifestRecord
): void {
  const list = target.get(key) ?? [];
  list.push(record);
  target.set(key, list);
}

/**
 * 拼接 ticker 与 variant 的稳定键。
 *
 * @param record ticker 与 variant。
 * @returns 单义字符串键。
 */
function variantTickerKey(
  record: Pick<ManifestTickerKey, "ticker"> & { variant: string }
): string {
  return `${record.ticker}\u0000${record.variant}`;
}
