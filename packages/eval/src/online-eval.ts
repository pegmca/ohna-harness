/**
 * 在线影子评测（docs/v1.1/04-eval-observability.md P4）：
 *
 * 本文件实现"影子"评测——这是离线/只读的观测手段。它只读取线上已采样的
 * `{ query, answer, contexts }` 三元组，并在本地跑 LLM-as-Judge（默认确定性 mock，无网络），
 * 输出答案正确性与忠实性分数。**它绝不写回生产、绝不修改任何 run / trace 状态**——线上采样的
 * 数据在进入本评测器之前已经落盘为只读样本，评测结果仅用于离线分析 dashboard。
 *
 * 设计要点：
 * - 纯函数为主，不依赖网络（默认 judge 为 createLoopLlmJudge 的确定性 mock，可复现）；
 * - evaluate 对单条样本打分，sampleAndEvaluate 并发跑整批样本；
 * - 无人工闭环、无状态副作用，便于在 CI / 离线批处理中复用。
 */
import { createLoopLlmJudge, type LoopLlmJudge } from "./judge-loop.js";

/** 单条影子评测结果（只读观测，不回写生产）。 */
export interface ShadowResult {
  /** 关联的样本用例 id。 */
  caseId: string;
  /** 用户查询（来自线上采样）。 */
  query: string;
  /** judge 判定的答案正确性（0~1）。 */
  answerCorrectness: number;
  /** judge 判定的忠实性（0~1）。 */
  faithfulness: number;
  /** 采样时间戳（ISO8601）。 */
  sampledAt: string;
  /** 期望参考文本（可选，来自线上标注或期望库）。 */
  expectedText?: string;
}

/** 单条影子评测的输入（线上采样数据，只读）。 */
export interface ShadowInput {
  /** 样本用例 id。 */
  caseId: string;
  /** 用户查询。 */
  query: string;
  /** 线上生成的答案。 */
  answer: string;
  /** 期望参考文本（可选）。 */
  expectedText?: string;
  /** 检索到的上下文文本列表（可选，用于忠实性判定）。 */
  contexts?: string[];
}

/** 影子评测器接口：对单条线上样本打分。 */
export interface ShadowEvaluator {
  /**
   * 对单条线上采样样本跑 judge，得到答案正确性与忠实性分数。
   * 注意：本方法只读 sample，绝不写回生产或改动 run 状态。
   *
   * @param input 线上采样输入（query / answer / contexts 等）。
   * @returns 影子评测结果（含采样时间）。
   */
  evaluate(input: ShadowInput): Promise<ShadowResult>;
}

/**
 * 创建影子评测器。
 *
 * 若未传入 judge，则内部使用 `createLoopLlmJudge()` 的确定性 mock 模式——可复现、无网络，
 * 保证离线批处理与测试的稳定输出。evaluate 仅读取传入的 sample 并在本地打分，绝不与生产系统交互。
 *
 * @param options 可选配置；其中 `judge` 允许注入真实或自定义 judge（如启用真实模型模式）。
 * @returns 影子评测器实例。
 */
export function createShadowEvaluator(options?: { judge?: LoopLlmJudge }): ShadowEvaluator {
  // 未传 judge 时回退到确定性 mock：可复现、无网络，符合"离线影子"定位。
  const judge = options?.judge ?? createLoopLlmJudge();

  return {
    async evaluate(input: ShadowInput): Promise<ShadowResult> {
      // 答案正确性：参考文本缺省时退化到用 query 本身比对（与 loop-runner 的兜底口径一致）。
      const correctness = await judge.judgeAnswerCorrectness(input.query, input.answer, input.expectedText ?? input.query);
      // 忠实性：无上下文时 judge 内部会返回中性分（不奖励也不惩罚）。
      const faithfulness = await judge.judgeFaithfulness(input.answer, input.contexts ?? []);

      return {
        caseId: input.caseId,
        query: input.query,
        answerCorrectness: correctness.score,
        faithfulness: faithfulness.score,
        sampledAt: new Date().toISOString(),
        expectedText: input.expectedText,
      };
    },
  };
}

/**
 * 并发跑整批线上采样样本（影子评测的批量入口）。
 *
 * 使用 `Promise.all` 同时评测所有样本；各样本相互独立，并发不影响分数与可复现性。
 * 返回结果数组的顺序与输入样本顺序一致。
 *
 * @param evaluator 影子评测器实例。
 * @param samples 线上采样输入数组。
 * @returns 与输入顺序对应的影子评测结果数组。
 */
export async function sampleAndEvaluate(
  evaluator: ShadowEvaluator,
  samples: ShadowInput[],
): Promise<ShadowResult[]> {
  return Promise.all(samples.map((sample) => evaluator.evaluate(sample)));
}
