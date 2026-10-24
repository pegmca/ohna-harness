/**
 * ohna 编码 Agent 评测数据集模块（v2.0 评测体系 Step 4 · 领域自治方案 §3.4 / ohna-eval-dataset 工作项）。
 *
 * 领域类型归属本文件（不进 `@aiagent/types`，兑现「领域 case 类型不进 types」）：
 * 编码 Agent 评测 case schema 是 ohna 语义（workspace 种子、文件改动期望、权限拒绝期望、预算收敛），
 * 与跨边界线格式 `EvalReportDto` 解耦。仅 `EvalReportDto` 等跨边界 DTO 走 `@aiagent/types`（在 index.ts 引用）。
 *
 * 关键约束（Step 4 验收 + 修 G8）：
 * - 每个 case 携带 `workspaceSeed`（评测运行前写入临时工作区的种子文件），保证自包含、可离线复现；
 * - `expectedToolCalls` 用 eval-core 的 `ToolCallStep[]` 表达（{tool, args?, isError?}），
 *   args 键集即该工具调用的「必填参数」，供 `toolSelectionCorrectness` 做参数级校验；
 * - `expectedFileChanges`（mustContain/forbid）/ `expectedPermissionDenials` / `maxTurns`
 *   分别喂给 `fileChangeCorrectness` / `permissionCompliance` / `turnEfficiency`；
 * - loader 做数据集级 `minCases` 校验（修 G8：不再硬校验 30-50，下限由数据集自带）。
 *
 * 指标边界（§3.1「无 mock 模型定调」）：本文件**只定义期望事实**，不参与打分；
 * 打分由 `metrics.ts` 依据真实工具副作用 + 文件快照 + 权限记录判定。`expectedToolCalls`
 * 同时被 integration 档的离线确定性 streamFn 用作「驱动脚本」——离线 streamFn 是测试用
 * provider 替身，仅驱动 agentLoop 走完控制流，不参与指标打分（真实打分在 live 档由真 provider 完成）。
 */

import { readFileSync } from "node:fs";
import type { ToolCallStep } from "@aiagent/eval-core";

/**
 * 评测模式：决定该 case 主要验证哪类指标。
 * - `coding`：read→edit/write 闭环，验证 fileChangeCorrectness + toolSelectionCorrectness；
 * - `permission`：触发权限闸门，验证 permissionCompliance；
 * - `budget`：超小 maxTurns 诱导多轮，验证 turnEfficiency 收敛。
 */
export type OhnaEvalMode = "coding" | "permission" | "budget";

/**
 * 单个种子文件（评测运行前写入临时工作区）。
 *
 * 路径相对临时工作区根（cwd），内容即该文件的初始内容。
 */
export interface OhnaWorkspaceSeed {
  /** 相对工作区根的文件路径（如 "src/greeting.ts"）。 */
  path: string;
  /** 文件初始内容（UTF-8 文本）。 */
  content: string;
}

/**
 * 期望文件改动断言（fileChangeCorrectness 用）。
 *
 * 评测结束后读取对应文件快照，校验 `mustContain` 全部出现且 `forbid` 全部不出现。
 */
export interface OhnaExpectedFileChange {
  /** 相对工作区根的文件路径。 */
  path: string;
  /** 文件最终内容必须包含的子串列表（任一缺失即判失败）。 */
  mustContain?: string[];
  /** 文件最终内容禁止出现的子串列表（任一出现即判失败）。 */
  forbid?: string[];
}

/**
 * 编码评测单条 case（领域 schema，不进 @aiagent/types）。
 *
 * 三类期望（expectedToolCalls / expectedFileChanges / expectedPermissionDenials）均为可选，
 * 由 `mode` 决定哪些指标 applicable（G5：无对应期望字段的指标不进聚合/门禁）。
 */
export interface OhnaEvalCase {
  /** case 唯一 id。 */
  id: string;
  /** 喂给 Agent 的 prompt（描述要完成的编码任务）。 */
  prompt: string;
  /** 评测模式（决定主验证指标）。 */
  mode: OhnaEvalMode;
  /** 运行前写入临时工作区的种子文件（保证 case 自包含）。 */
  workspaceSeed?: OhnaWorkspaceSeed[];
  /** 期望工具调用序列（供 toolSelectionCorrectness / 离线 streamFn 驱动脚本）。 */
  expectedToolCalls?: ToolCallStep[];
  /** 期望文件改动（供 fileChangeCorrectness）。 */
  expectedFileChanges?: OhnaExpectedFileChange[];
  /** 期望被权限闸门拒绝的工具名（供 permissionCompliance）。 */
  expectedPermissionDenials?: string[];
  /** 预算轮数上限（供 turnEfficiency：实际 turns 超过即判超预算）。 */
  maxTurns?: number;
  /** 可选语义描述（用于报告可读性与失败回灌）。 */
  expectedOutcome?: string;
}

/**
 * 编码评测数据集（loader 解析产物）。
 */
export interface OhnaEvalDataset {
  /** schema 版本（如 2.0.0）。 */
  schemaVersion: string;
  /** 数据集版本标识（如 ohna-coding-v1.0.0）。 */
  datasetVersion: string;
  /** 随机种子（可复现性，可选）。 */
  seed?: number;
  /** 数据集领域（默认 ohna）。 */
  domain?: string;
  /** 数据集级最小 case 数（修 G8：不再硬校验 30-50）。 */
  minCases: number;
  /** 全部 case。 */
  cases: OhnaEvalCase[];
}

/**
 * loader 选项。
 */
export interface LoadOhnaDatasetOptions {
  /** 数据集级最小 case 数下限覆盖；缺省取数据集自带 minCases（仍不得低于 1）。 */
  minCases?: number;
}

/**
 * 校验单个 case 的基础结构合法性，不合法时抛出带 id 的错误。
 *
 * @param case_ 待校验 case（unknown，运行时来自 JSON）。
 * @param index 数组下标，用于错误定位。
 */
function assertCaseShape(case_: unknown, index: number): asserts case_ is OhnaEvalCase {
  if (typeof case_ !== "object" || case_ === null) {
    throw new Error(`case[${index}] 不是对象`);
  }
  const c = case_ as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0) {
    throw new Error(`case[${index}] 缺少合法 id`);
  }
  if (typeof c.prompt !== "string" || c.prompt.length === 0) {
    throw new Error(`case ${c.id} 缺少合法 prompt`);
  }
  if (!["coding", "permission", "budget"].includes(c.mode as string)) {
    throw new Error(`case ${c.id} mode 非法：${String(c.mode)}`);
  }

  // workspaceSeed 校验（若有）。
  if (c.workspaceSeed !== undefined) {
    if (!Array.isArray(c.workspaceSeed)) {
      throw new Error(`case ${c.id} workspaceSeed 必须是数组`);
    }
    for (const seed of c.workspaceSeed as unknown[]) {
      if (typeof seed !== "object" || seed === null) {
        throw new Error(`case ${c.id} workspaceSeed 含非对象元素`);
      }
      const s = seed as Record<string, unknown>;
      if (typeof s.path !== "string" || typeof s.content !== "string") {
        throw new Error(`case ${c.id} workspaceSeed 元素缺少 path/content`);
      }
    }
  }

  // expectedToolCalls 校验（若有）：复用 ToolCallStep 形状。
  if (c.expectedToolCalls !== undefined) {
    if (!Array.isArray(c.expectedToolCalls)) {
      throw new Error(`case ${c.id} expectedToolCalls 必须是数组`);
    }
    for (const step of c.expectedToolCalls as unknown[]) {
      if (typeof step !== "object" || step === null) {
        throw new Error(`case ${c.id} expectedToolCalls 含非对象元素`);
      }
      const st = step as Record<string, unknown>;
      if (typeof st.tool !== "string" || st.tool.length === 0) {
        throw new Error(`case ${c.id} expectedToolCalls 元素缺少 tool`);
      }
    }
  }

  // expectedFileChanges 校验（若有）。
  if (c.expectedFileChanges !== undefined) {
    if (!Array.isArray(c.expectedFileChanges)) {
      throw new Error(`case ${c.id} expectedFileChanges 必须是数组`);
    }
    for (const fc of c.expectedFileChanges as unknown[]) {
      if (typeof fc !== "object" || fc === null) {
        throw new Error(`case ${c.id} expectedFileChanges 含非对象元素`);
      }
      const f = fc as Record<string, unknown>;
      if (typeof f.path !== "string") {
        throw new Error(`case ${c.id} expectedFileChanges 元素缺少 path`);
      }
      if (f.mustContain !== undefined && !Array.isArray(f.mustContain)) {
        throw new Error(`case ${c.id} expectedFileChanges.mustContain 必须是数组`);
      }
      if (f.forbid !== undefined && !Array.isArray(f.forbid)) {
        throw new Error(`case ${c.id} expectedFileChanges.forbid 必须是数组`);
      }
    }
  }

  // expectedPermissionDenials 校验（若有）。
  if (c.expectedPermissionDenials !== undefined) {
    if (!Array.isArray(c.expectedPermissionDenials)) {
      throw new Error(`case ${c.id} expectedPermissionDenials 必须是数组`);
    }
    for (const tool of c.expectedPermissionDenials as unknown[]) {
      if (typeof tool !== "string") {
        throw new Error(`case ${c.id} expectedPermissionDenials 含非字符串元素`);
      }
    }
  }

  // maxTurns 校验（若有）：应为正整数。
  if (c.maxTurns !== undefined) {
    if (typeof c.maxTurns !== "number" || !Number.isInteger(c.maxTurns) || c.maxTurns <= 0) {
      throw new Error(`case ${c.id} maxTurns 必须是正整数`);
    }
  }
}

/**
 * 加载并校验 ohna 编码评测数据集。
 *
 * 校验内容：
 * - JSON 可解析、含 cases 数组；
 * - 每个 case 结构合法（见 assertCaseShape）；
 * - case 数不低于数据集级 minCases（修 G8，不再硬校验 30-50）；
 * - 按 mode 交叉校验关键期望字段存在（coding 需 expectedToolCalls 或 expectedFileChanges；
 *   permission 需 expectedPermissionDenials；budget 需 maxTurns），否则属数据集错误。
 *
 * @param path 数据集 JSON 路径（绝对或相对）。
 * @param options 可选 minCases 覆盖。
 * @returns 解析后的数据集。
 */
export function loadOhnaDataset(path: string, options: LoadOhnaDatasetOptions = {}): OhnaEvalDataset {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`无法解析数据集 ${path}：${(err as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).cases)) {
    throw new Error(`数据集 ${path} 缺少 cases 数组`);
  }
  const data = raw as Record<string, unknown>;
  const cases = data.cases as unknown[];

  cases.forEach((c, i) => assertCaseShape(c, i));

  const minCases = Math.max(1, options.minCases ?? (typeof data.minCases === "number" ? data.minCases : 1));
  if (cases.length < minCases) {
    throw new Error(`数据集 case 数 ${cases.length} 低于数据集级下限 ${minCases}（修 G8：不再硬校验 30-50）`);
  }

  // 按 mode 交叉校验期望字段（缺关键期望即属数据集设计错误，提前暴露）。
  for (const c of cases as OhnaEvalCase[]) {
    if (c.mode === "coding" && !c.expectedToolCalls?.length && !c.expectedFileChanges?.length) {
      throw new Error(`coding case ${c.id} 至少需要 expectedToolCalls 或 expectedFileChanges`);
    }
    if (c.mode === "permission" && !c.expectedPermissionDenials?.length) {
      throw new Error(`permission case ${c.id} 缺少 expectedPermissionDenials`);
    }
    if (c.mode === "budget" && typeof c.maxTurns !== "number") {
      throw new Error(`budget case ${c.id} 缺少正整数 maxTurns`);
    }
  }

  return {
    schemaVersion: typeof data.schemaVersion === "string" ? data.schemaVersion : "2.0.0",
    datasetVersion: typeof data.datasetVersion === "string" ? data.datasetVersion : "ohna-coding-v1.0.0",
    seed: typeof data.seed === "number" ? data.seed : undefined,
    domain: typeof data.domain === "string" ? data.domain : "ohna",
    minCases,
    cases: cases as OhnaEvalCase[],
  };
}
