/**
 * ohna 编码 Agent 评测 judge rubric（v2.0 评测体系 Step 4，领域自治方案 §2.3 边界修正）。
 *
 * 内核只提供「解析 / 投票 / 降级」机械零件（@aiagent/eval-core 的 parseJudgeJson / roundScore
 * / NEUTRAL_SCORE 等）；rubric prompt 文本与真实模型调用留 app 层。本文件：
 * - 导出 fileChangeQuality / toolChoiceRationale 两个 rubric 的 systemPrompt 常量与解析器
 *   （rubric 文本与调用留 app，内核只提供 parseJudgeJson / roundScore 等框架）。
 * - createOhnaCodingJudge(options?) 返回 run 层需要的 `OhnaCodingJudge` 适配器：有 callModel
 *   注入时用替身，否则复用 @aiagent/ai 的 provider 配置真实调用；无配置时整体返回 null
 *   （run 层据此跳过 judge，不影响确定性门禁——judge 只产校准信号，不进聚合/门禁）。
 *
 * 与 finance-api 的 judge 同范式：judge 评分**不参与 CI 门禁**，仅作为人工查看的校准信号。
 */

import { parseJudgeJson, roundScore, NEUTRAL_SCORE } from "@aiagent/eval-core";
import type { OhnaCodingJudge } from "./run.js";
import type { OhnaEvalCase } from "./dataset.js";
import type { OhnaCaseEvidence } from "./metrics.js";

/** judge 输出里的分数键名（与 rubric 约定一致）。 */
const SCORE_KEYS = ["score", "quality", "rationale"] as const;

/**
 * 从 judge 模型返回的任意 JSON 中抽取分数（稳健：尝试多个常见键名）。
 *
 * @param text 模型返回文本。
 * @returns 受限到 [0,1] 的分数；解析失败或字段缺失时返回中性分。
 */
function extractScore(text: string): number {
  const parsed = parseJudgeJson(text);
  if (!parsed) return NEUTRAL_SCORE;
  for (const key of SCORE_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "number") return roundScore(value);
  }
  return NEUTRAL_SCORE;
}

/** fileChangeQuality rubric：判断文件改动是否精准命中需求（不破坏其它文件）。 */
export const FILE_CHANGE_QUALITY_SYSTEM_PROMPT = [
  "你是编码 Agent 评测的 fileChangeQuality 裁判。",
  "给定「用户任务 / 执行后的文件快照 / 期望文件内容」，判断改动是否精准命中需求：",
  "完全匹配且未破坏其它文件 → 1.0；部分命中 → 0.5；明显偏离或未改动 → 0.0。",
  "只输出 JSON：{\"score\": <0..1>, \"reason\": \"<中文简评>\"}。",
].join("\n");

/** toolChoiceRationale rubric：判断工具选择序列是否合理（读前改 / 写后验证）。 */
export const TOOL_CHOICE_RATIONALE_SYSTEM_PROMPT = [
  "你是编码 Agent 评测的 toolChoiceRationale 裁判。",
  "给定「用户任务 / 实际工具调用序列」，判断工具选择顺序是否合理：",
  "先 read 探查再 edit/write、必要时 bash 验证 → 1.0；顺序瑕疵 → 0.5；选错工具 → 0.0。",
  "只输出 JSON：{\"score\": <0..1>, \"reason\": \"<中文简评>\"}。",
].join("\n");

/** 每个 rubric 名对应的系统提示（供 createOhnaCodingJudge 取用）。 */
const RUBRIC_PROMPTS: Record<string, string> = {
  fileChangeQuality: FILE_CHANGE_QUALITY_SYSTEM_PROMPT,
  toolChoiceRationale: TOOL_CHOICE_RATIONALE_SYSTEM_PROMPT,
};

/**
 * 把一条 case + 确定性证据渲染为某 rubric 的用户提示。
 *
 * @param rubric rubric 名。
 * @param case_ 评测 case。
 * @param evidence 确定性证据（轨迹 / 快照 / 拒绝 / 轮数）。
 * @returns 用户提示文本。
 */
function renderUserPrompt(
  rubric: string,
  case_: OhnaEvalCase,
  evidence: OhnaCaseEvidence,
): string {
  const trajectory = evidence.trajectory.map((step) => step.tool).join(" → ");
  if (rubric === "fileChangeQuality") {
    const expected = (case_.expectedFileChanges ?? [])
      .map((item) => `- ${item.path}: 必须包含 ${JSON.stringify(item.mustContain ?? [])}`)
      .join("\n");
    const actual = [...evidence.workspaceSnapshot.entries()]
      .map(([path, content]) => `- ${path}: ${content.slice(0, 200)}`)
      .join("\n");
    return `用户任务：${case_.prompt}\n\n期望文件：\n${expected}\n\n实际文件快照：\n${actual}`;
  }
  return `用户任务：${case_.prompt}\n\n实际工具调用序列：${trajectory}`;
}

/**
 * 创建 ohna 编码 judge 适配器。
 *
 * 测试 / 注入替身场景：显式传入 callModel 时直接使用，不依赖 provider 配置（否则无法离线验证）。
 * 真实场景复用 @aiagent/ai 的 provider 配置；**缺配置直接返回 null**（不静默回退），由 run 层
 * 决定跳过 judge（不静默回退、不影响确定性门禁）。
 *
 * @param options 可选：callModel 注入（测试可用替身）；不传则使用真实 provider（缺配置返回 null）。
 * @returns OhnaCodingJudge 适配器，或 null（无 judge 配置）。
 */
export function createOhnaCodingJudge(
  options?: { callModel?: (system: string, user: string) => Promise<string> },
): OhnaCodingJudge | null {
  if (options?.callModel) {
    return buildJudge(options.callModel);
  }

  // 真实场景：复用 @aiagent/ai 的 provider 配置（本仓库当前未配置 key）。
  // 为保持与 finance-api 同范式且避免无配置静默回退，这里直接返回 null，
  // 由 run 层跳过 judge——确定性指标与门禁不受影响。
  // 如需启用真实 judge，可在此读取 provider 配置后构造 callModel（fetch /chat/completions）。
  return null;
}

/**
 * 用给定的模型调用边界构建 judge 适配器（注入与现实 fetch 两条路径共用）。
 *
 * @param callModel 模型调用边界（注入替身或真实 fetch）。
 * @returns OhnaCodingJudge 适配器。
 */
function buildJudge(callModel: (system: string, user: string) => Promise<string>): OhnaCodingJudge {
  return {
    async score(rubric, case_, evidence) {
      const system = RUBRIC_PROMPTS[rubric] ?? FILE_CHANGE_QUALITY_SYSTEM_PROMPT;
      const user = renderUserPrompt(rubric, case_, evidence);
      const text = await callModel(system, user).catch(() => JSON.stringify({ score: NEUTRAL_SCORE }));
      return extractScore(text);
    },
  };
}
