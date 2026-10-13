/**
 * 真实 benchmark 适配器（docs/v1.1/04-eval-observability.md P4）：
 *
 * 本文件把外部真实 benchmark（如 GAIA、TAU-bench）统一适配成包内已有的 `UnifiedEvalCase` /
 * `EvalDataset`，从而复用 `runLoopEval` 的整套确定性打分与回归门禁，无需改动下游管线。
 *
 * **扩展点说明**：真实 GAIA / TAU-bench 集成只需实现 `BenchmarkAdapter.loadCases()`——
 * 改走数据集抓取或官方 API（`getQuestions` / `submitRun` 等），把远端题目映射为 `BenchmarkCase`
 * 即可。`benchmarkCaseToUnified` → `benchmarkDatasetToEvalDataset` → `runLoopEval` 的三段管线
 * 完全不变。当前仅提供确定性的 mock 适配器（`createMockGaiaAdapter` / `createMockTauBenchAdapter`），
 * 用于教学与离线评测，**不发起任何外部 HTTP 请求、不引入任何网络依赖**。
 */
import {
  type EvalDataset,
  type UnifiedEvalCase,
  type FinancialFactExpectation,
} from "./automation.js";

/** 真实 benchmark 单条用例（适配器内部的中间表示，与具体数据集解耦）。 */
export interface BenchmarkCase {
  /** 用例 id（mock 适配器以 `gaia-` / `tau-` 前缀区分来源）。 */
  id: string;
  /** 用户查询 / 任务描述。 */
  query: string;
  /** 期望答案（用于合成 fixture.answer 与 judge 参考文本）。 */
  expectedAnswer: string;
  /** 任务模式：chat / rag / report，直接映射到 EvalMode。 */
  mode: "chat" | "rag" | "report";
  /** 用例标签（领域 / 难度等维度）。 */
  tags: string[];
  /** 期望财务事实（可选）：用于复用确定性财务准确率指标。 */
  expectedFacts?: Array<{ label: string; value: number; unit: string; period: string; source: string }>;
}

/** benchmark 适配器接口：每个真实数据集实现一个 loadCases。 */
export interface BenchmarkAdapter {
  /** 适配器 id（用作 datasetVersion）。 */
  id: string;
  /** 适配器描述（来源 / 用途）。 */
  description: string;
  /**
   * 加载用例：真实实现应改为数据集抓取 / 官方 API；当前 mock 返回确定性数组。
   * 不校验用例数量（仅 loadEvalDataset 校验 30~50），小样本也能直接喂给 runLoopEval。
   *
   * @returns benchmark 用例数组。
   */
  loadCases(): Promise<BenchmarkCase[]>;
}

/**
 * 把单条 `BenchmarkCase` 合成合法的 `UnifiedEvalCase`。
 *
 * 合成策略：把 `expectedAnswer` 当作 fixture.answer；不注入检索/引用/工作流等真实证据
 * （离线 mock，fixture 恒为 ok=true、各确定性指标为满分基线），`expectedFacts` 对齐到
 * `FinancialFactExpectation`。下游 `runLoopEval` 仅做结构投影，不影响既有门禁语义。
 *
 * @param c 真实 benchmark 用例。
 * @param datasetVersion 数据集版本（取自 adapter.id）。
 * @returns 合法的 UnifiedEvalCase（可直接进入 EvalDataset）。
 */
export function benchmarkCaseToUnified(c: BenchmarkCase, datasetVersion: string): UnifiedEvalCase {
  const fixture: UnifiedEvalCase["fixture"] = {
    answer: c.expectedAnswer,
    citations: [],
    retrievedChunks: [],
    workflow: [],
    sections: [],
    exportStatus: undefined,
    ok: true,
    latencyMs: 0,
    traceId: `bench-${c.id}`,
    requestId: `bench-req-${c.id}`,
  };

  // BenchmarkCase.expectedFacts 字段集是 FinancialFactExpectation 的子集（currency 可选省略）。
  const expectedFacts: FinancialFactExpectation[] = (c.expectedFacts ?? []).map((fact) => ({
    label: fact.label,
    value: fact.value,
    unit: fact.unit,
    period: fact.period,
    source: fact.source,
  }));

  return {
    id: c.id,
    mode: c.mode,
    query: c.query,
    expectedFacts,
    expectedCitations: [],
    expectedWorkflow: [],
    expectedSections: [],
    tags: c.tags,
    fixture,
  };
}

/**
 * 把适配器加载的用例包成 `EvalDataset`，可直接传给 `runLoopEval`。
 *
 * @param adapter benchmark 适配器（提供 id 与 loadCases）。
 * @param seed 随机种子（用于报告 run.id 与可复现标识）。
 * @returns 由 benchmark 用例构成的 EvalDataset。
 */
export async function benchmarkDatasetToEvalDataset(
  adapter: BenchmarkAdapter,
  seed: number,
): Promise<EvalDataset> {
  const cases = await adapter.loadCases();
  return {
    schemaVersion: "1.0.0",
    datasetVersion: adapter.id,
    seed,
    cases: cases.map((item) => benchmarkCaseToUnified(item, adapter.id)),
  };
}

/**
 * 创建确定性 GAIA mock 适配器（open-domain 金融/常识 QA，离线教学用）。
 *
 * 不发起任何外部 HTTP；返回 3~5 条以 `gaia-` 为前缀、mode 为 `chat` 的确定性用例，
 * 含 `expectedFacts` 以便复用财务准确率指标。
 *
 * @returns 确定性 GAIA mock 适配器。
 */
export function createMockGaiaAdapter(): BenchmarkAdapter {
  return {
    id: "gaia-mock-v1",
    description: "GAIA 风格 open-domain 金融/常识 QA（确定性 mock，离线教学用，不发起外部请求）。",
    async loadCases(): Promise<BenchmarkCase[]> {
      return [
        {
          id: "gaia-1",
          query: "特斯拉 2023 年的全年交付量是多少？",
          expectedAnswer: "特斯拉 2023 年全年交付量为 1,808,581 辆。",
          mode: "chat",
          tags: ["open-domain", "finance", "delivery"],
          expectedFacts: [
            { label: "全年交付量", value: 1808581, unit: "辆", period: "2023", source: "Tesla IR" },
          ],
        },
        {
          id: "gaia-2",
          query: "苹果公司成立于哪一年？",
          expectedAnswer: "苹果公司成立于 1976 年。",
          mode: "chat",
          tags: ["open-domain", "company", "founded"],
          expectedFacts: [
            { label: "成立年份", value: 1976, unit: "年", period: "1976", source: "Apple IR" },
          ],
        },
        {
          id: "gaia-3",
          query: "伯克希尔哈撒韦 2022 年的净利润是多少？",
          expectedAnswer: "伯克希尔哈撒韦 2022 年净利润为 962 亿美元。",
          mode: "chat",
          tags: ["open-domain", "finance", "net-income"],
          expectedFacts: [
            { label: "净利润", value: 962, unit: "亿美元", period: "2022", source: "Berkshire Hathaway 10-K" },
          ],
        },
        {
          id: "gaia-4",
          query: "美元兑人民币 2024 年初的汇率大约是多少？",
          expectedAnswer: "2024 年初美元兑人民币汇率大约为 7.2。",
          mode: "chat",
          tags: ["open-domain", "fx", "macro"],
          expectedFacts: [
            { label: "USD/CNY 汇率", value: 7.2, unit: "元", period: "2024", source: "PBOC" },
          ],
        },
      ];
    },
  };
}

/**
 * 创建确定性 TAU-bench mock 适配器（agent / 工具调用场景，离线教学用）。
 *
 * 不发起任何外部请求；返回 3~5 条以 `tau-` 为前缀、mode 为 `rag` 或 `report` 的确定性用例，
 * 含 `expectedFacts` 以便复用财务准确率指标。
 *
 * @returns 确定性 TAU-bench mock 适配器。
 */
export function createMockTauBenchAdapter(): BenchmarkAdapter {
  return {
    id: "tau-bench-mock-v1",
    description: "TAU-bench 风格 agent/工具调用场景（确定性 mock，离线教学用，不发起外部请求）。",
    async loadCases(): Promise<BenchmarkCase[]> {
      return [
        {
          id: "tau-1",
          query: "检索 2023 年阿里巴巴的年报并核对其营收数据。",
          expectedAnswer: "阿里巴巴 2023 年营收为 9411.68 亿元人民币。",
          mode: "rag",
          tags: ["agent", "retrieval", "revenue"],
          expectedFacts: [
            { label: "营收", value: 9411.68, unit: "亿元", period: "2023", source: "Alibaba 20-F" },
          ],
        },
        {
          id: "tau-2",
          query: "生成一份关于英伟达 2024 财年业绩的研究报告。",
          expectedAnswer: "英伟达 2024 财年营收为 609.22 亿美元，净利润为 297.56 亿美元。",
          mode: "report",
          tags: ["agent", "report", "semiconductor"],
          expectedFacts: [
            { label: "营收", value: 609.22, unit: "亿美元", period: "2024财年", source: "NVIDIA 10-K" },
            { label: "净利润", value: 297.56, unit: "亿美元", period: "2024财年", source: "NVIDIA 10-K" },
          ],
        },
        {
          id: "tau-3",
          query: "对比 2022 与 2023 年微软的云计算收入。",
          expectedAnswer: "微软智能云 2022 年收入为 818 亿美元，2023 年为 962 亿美元。",
          mode: "rag",
          tags: ["agent", "comparison", "cloud"],
          expectedFacts: [
            { label: "智能云收入", value: 818, unit: "亿美元", period: "2022", source: "Microsoft 10-K" },
            { label: "智能云收入", value: 962, unit: "亿美元", period: "2023", source: "Microsoft 10-K" },
          ],
        },
      ];
    },
  };
}
