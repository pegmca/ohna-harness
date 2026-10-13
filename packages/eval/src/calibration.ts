/**
 * 人工校准（docs/v1.1/04-eval-observability.md P4）：
 *
 * 本文件实现"人工标注回流校准 judge 偏差"的最小可用版本。judge（默认确定性 mock 或真实模型）
 * 的分数可能系统性偏高 / 偏低，人工抽样标注提供真实基准。我们用"带人工标注样本上的
 * 人类均值 − judge 均值"作为全局偏差，把所有 judge 原始分数平移并钳制到 [0,1]。
 *
 * 设计要点：
 * - 纯函数、不依赖网络 / IO，可单测；
 * - 同一 case 可录多条人工标注（取平均），降低单人主观误差；
 * - 无人工标注时偏差为 0，calibratedScore 直接等于 rawScore（零回归、可解释）。
 */

/** 人工校准标注存储接口：按 caseId 聚合多份人工评分。 */
export interface HumanCalibrationStore {
  /**
   * 记录一条人工评分（同一 case 可录多条，取平均）。
   *
   * @param caseId 用例 id。
   * @param humanScore 人工给出的 0~1 分数。
   */
  recordLabel(caseId: string, humanScore: number): void;

  /**
   * 取某 case 的全部人工评分（未录返回空数组）。
   *
   * @param caseId 用例 id。
   * @returns 该 case 的人工分数数组。
   */
  getLabels(caseId: string): number[];

  /**
   * 取全部人工标注（caseId → 分数数组）。
   *
   * @returns 全量标注映射。
   */
  getAllLabels(): Record<string, number[]>;

  /** 清空所有标注。 */
  clear(): void;
}

/**
 * 创建内存版人工标注存储（仅进程内，适合测试与离线批处理）。
 * 用 `Map<string, number[]>` 实现，同一 case 可累积多条标注取平均。
 *
 * @returns 内存人工校准存储实例。
 */
export function createInMemoryCalibrationStore(): HumanCalibrationStore {
  const labels = new Map<string, number[]>();

  return {
    recordLabel(caseId: string, humanScore: number): void {
      const existing = labels.get(caseId) ?? [];
      existing.push(humanScore);
      labels.set(caseId, existing);
    },
    getLabels(caseId: string): number[] {
      return labels.get(caseId) ?? [];
    },
    getAllLabels(): Record<string, number[]> {
      return Object.fromEntries(labels.entries());
    },
    clear(): void {
      labels.clear();
    },
  };
}

/** 单条校准输入（judge 原始分数）。 */
export interface CalibrationInput {
  /** 用例 id。 */
  caseId: string;
  /** judge 原始分数（0~1）。 */
  score: number;
}

/** 单条校准输出（含偏差与是否有人工标注）。 */
export interface CalibrationOutput {
  /** 用例 id。 */
  caseId: string;
  /** judge 原始分数。 */
  rawScore: number;
  /** 校准后的分数（钳制到 [0,1]）。 */
  calibratedScore: number;
  /** 应用的全局偏差。 */
  bias: number;
  /** 该 case 是否有人工标注。 */
  hasHumanLabel: boolean;
}

/**
 * 把 judge 原始分数按全局偏差校准。
 *
 * 偏差计算：仅基于"带人工标注的 case"——`bias = mean(人工标注均值) − mean(judge 原始分数)`，
 * 其中均值都只在有标注的 case 集合上计算；若无任何带标注的 case，则 `bias = 0`（不偏移）。
 * 每个输入输出 `calibratedScore = clamp01(rawScore + bias)`，并记录是否有人工标注。
 *
 * @param judgeScores 待校准的 judge 原始分数列表。
 * @param store 人工标注存储（提供真实基准）。
 * @returns 校准后的结果数组（顺序与输入一致）。
 */
export function calibrateJudgeScores(
  judgeScores: CalibrationInput[],
  store: HumanCalibrationStore,
): CalibrationOutput[] {
  // 仅在有标注的 case 上计算偏差：避免无标注 case 污染基准。
  const labeled = judgeScores.filter((item) => store.getLabels(item.caseId).length > 0);

  let bias = 0;
  if (labeled.length > 0) {
    const humanMean =
      labeled.reduce((sum, item) => {
        const ls = store.getLabels(item.caseId);
        return sum + ls.reduce((a, b) => a + b, 0) / ls.length;
      }, 0) / labeled.length;
    const judgeMean = labeled.reduce((sum, item) => sum + item.score, 0) / labeled.length;
    bias = humanMean - judgeMean;
  }

  return judgeScores.map((item) => ({
    caseId: item.caseId,
    rawScore: item.score,
    calibratedScore: clamp01(item.score + bias),
    bias,
    hasHumanLabel: store.getLabels(item.caseId).length > 0,
  }));
}

/**
 * 把分数限制在 [0,1] 区间（钳制）。
 *
 * @param score 原始分数（可能越界）。
 * @returns 受限后的分数。
 */
function clamp01(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}
