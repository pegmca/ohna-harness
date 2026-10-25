/**
 * team 评测数据集 loader 与 schema 校验（docs/v2.0/03-team-eval.md §8）。
 *
 * 与 coding loader（`../dataset.ts`）并列但独立：team 数据集是**独立文件**
 * `datasets/ohna/team-v1.json`，绝不混进 `coding-v1.json`（避免 `fileChangeCorrectness`
 * 被 team case 虚高/摊薄）。
 *
 * 校验策略（失败即抛，不做「宽容解析」）：
 * 1. 结构：每个 case 必须含 id / prompt / mode，mode 必须在 `TeamEvalMode` 枚举内；
 * 2. 语义：按 mode 交叉校验关键期望字段（如 `over_budget` 必须有成本上限、
 *    `member_not_found` 必须派发给不存在的成员），数据集设计错误提前暴露；
 * 3. 数量：case 数 ≥ `minCases`（数据集自带，且不得低于 §8 的 20 条下限）。
 *
 * 为什么语义校验要按 mode 做：team 评测的分层断言完全由 mode 决定（见 metrics.ts），
 * 一个声明 `over_budget` 却没有 `maxTokensTotal` 的 case 会在运行时静默「无护栏」通过——
 * 这正是「静默通过」红线，必须在加载期拦住。
 */

import { readFileSync } from "node:fs";
import type { TeamEvalCase, TeamEvalDataset, TeamEvalMode, TeamExpectedMember } from "./types.js";

/** §8 规定 team 数据集的最小 case 数（loader 底线，不可被数据集下调）。 */
export const TEAM_DATASET_MIN_CASES = 20;

/** 合法 mode 集合（运行时枚举，供校验使用）。 */
const VALID_MODES: readonly TeamEvalMode[] = [
  "dispatch",
  "member_not_found",
  "over_budget",
  "permission_deny",
  "concurrency",
  "failure_isolation",
];

/**
 * 校验成员期望结构的合法性。
 *
 * @param member 待校验成员期望（unknown，运行时来自 JSON）。
 * @param where 错误定位前缀（如 `case x.members[0]`）。
 */
function assertMemberShape(member: unknown, where: string): asserts member is TeamExpectedMember {
  if (typeof member !== "object" || member === null) {
    throw new Error(`${where} 不是对象`);
  }
  const m = member as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new Error(`${where} 缺少合法 name`);
  }
  if (m.role !== undefined && typeof m.role !== "string") {
    throw new Error(`${where} role 必须是字符串`);
  }
  if (m.allowedTools !== undefined) {
    if (!Array.isArray(m.allowedTools) || m.allowedTools.some((tool) => typeof tool !== "string")) {
      throw new Error(`${where} allowedTools 必须是字符串数组`);
    }
  }
}

/**
 * 校验单条 team case 的基础结构（不含 mode 级语义校验）。
 *
 * @param case_ 待校验 case（unknown）。
 * @param index 数组下标（错误定位）。
 */
function assertCaseShape(case_: unknown, index: number): asserts case_ is TeamEvalCase {
  if (typeof case_ !== "object" || case_ === null) {
    throw new Error(`team case[${index}] 不是对象`);
  }
  const c = case_ as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0) {
    throw new Error(`team case[${index}] 缺少合法 id`);
  }
  if (typeof c.prompt !== "string" || c.prompt.length === 0) {
    throw new Error(`team case ${c.id} 缺少合法 prompt`);
  }
  if (!VALID_MODES.includes(c.mode as TeamEvalMode)) {
    throw new Error(`team case ${c.id} mode 非法：${String(c.mode)}（应为 ${VALID_MODES.join("|")}）`);
  }

  if (c.availableTools !== undefined) {
    if (!Array.isArray(c.availableTools) || c.availableTools.some((tool) => typeof tool !== "string")) {
      throw new Error(`team case ${c.id} availableTools 必须是字符串数组`);
    }
  }

  for (const key of ["members", "expectedSpawns"] as const) {
    const value = c[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error(`team case ${c.id} ${key} 必须是数组`);
    value.forEach((member, i) => assertMemberShape(member, `case ${c.id} ${key}[${i}]`));
  }

  if (c.expectedSends !== undefined) {
    if (!Array.isArray(c.expectedSends)) throw new Error(`team case ${c.id} expectedSends 必须是数组`);
    for (const send of c.expectedSends as unknown[]) {
      if (typeof send !== "object" || send === null) {
        throw new Error(`team case ${c.id} expectedSends 含非对象元素`);
      }
      const s = send as Record<string, unknown>;
      if (typeof s.recipient !== "string" || s.recipient.length === 0) {
        throw new Error(`team case ${c.id} expectedSends 元素缺少 recipient`);
      }
      if (typeof s.content !== "string") {
        throw new Error(`team case ${c.id} expectedSends 元素缺少 content`);
      }
      if (s.estimatedTokens !== undefined && (typeof s.estimatedTokens !== "number" || s.estimatedTokens < 0)) {
        throw new Error(`team case ${c.id} expectedSends.estimatedTokens 必须是非负数`);
      }
    }
  }

  if (c.expectedToolCalls !== undefined) {
    if (!Array.isArray(c.expectedToolCalls)) throw new Error(`team case ${c.id} expectedToolCalls 必须是数组`);
    for (const step of c.expectedToolCalls as unknown[]) {
      if (typeof step !== "object" || step === null) {
        throw new Error(`team case ${c.id} expectedToolCalls 含非对象元素`);
      }
      const st = step as Record<string, unknown>;
      if (typeof st.tool !== "string" || st.tool.length === 0) {
        throw new Error(`team case ${c.id} expectedToolCalls 元素缺少 tool`);
      }
    }
  }

  if (c.expectedMemberStatus !== undefined) {
    const statuses = c.expectedMemberStatus as Record<string, unknown>;
    if (typeof statuses !== "object" || statuses === null) {
      throw new Error(`team case ${c.id} expectedMemberStatus 必须是对象`);
    }
    for (const [member, status] of Object.entries(statuses)) {
      if (!["idle", "running", "done", "failed"].includes(status as string)) {
        throw new Error(`team case ${c.id} expectedMemberStatus["${member}"] 非法：${String(status)}`);
      }
    }
  }

  if (c.expectedResultStatus !== undefined && !["done", "failed"].includes(c.expectedResultStatus as string)) {
    throw new Error(`team case ${c.id} expectedResultStatus 非法：${String(c.expectedResultStatus)}`);
  }

  // `l1ProbeMode` 是 T-L1 探针的选择器：非法值会让 `abortInputFor` / `abortCodeTransparent`
  // 一路落到缺省（clean）分支——探针照跑、指标判 1，数据集却什么都没测到。
  // 这正是「校验但不生效」的静默通道，必须在加载期硬拦。
  if (c.l1ProbeMode !== undefined) {
    const modes: readonly unknown[] = ["clean", "end_error", "stop_reason_error", "with_hooks", "misuse"];
    if (!modes.includes(c.l1ProbeMode)) {
      throw new Error(`team case ${c.id} l1ProbeMode 非法：${String(c.l1ProbeMode)}（可选 ${modes.join(" / ")}）`);
    }
  }

  if (c.expectedPermissionDenials !== undefined) {
    if (!Array.isArray(c.expectedPermissionDenials) || c.expectedPermissionDenials.some((t) => typeof t !== "string")) {
      throw new Error(`team case ${c.id} expectedPermissionDenials 必须是字符串数组`);
    }
  }

  if (c.expectedPermission !== undefined) {
    const p = c.expectedPermission as Record<string, unknown>;
    if (typeof p !== "object" || p === null) {
      throw new Error(`team case ${c.id} expectedPermission 必须是对象`);
    }
    for (const key of ["deniedTools", "grantedTools"] as const) {
      const list = p[key];
      if (list !== undefined && (!Array.isArray(list) || list.some((t) => typeof t !== "string"))) {
        throw new Error(`team case ${c.id} expectedPermission.${key} 必须是字符串数组`);
      }
    }
  }

  for (const key of ["maxConcurrentMembers", "maxTokensTotal", "maxTurns"] as const) {
    const value = c[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`team case ${c.id} ${key} 必须是正整数`);
    }
  }

  if (c.maxCostPerMember !== undefined && (typeof c.maxCostPerMember !== "number" || c.maxCostPerMember <= 0)) {
    throw new Error(`team case ${c.id} maxCostPerMember 必须是正数`);
  }

  if (c.failSubagentExecution !== undefined && typeof c.failSubagentExecution !== "boolean") {
    throw new Error(`team case ${c.id} failSubagentExecution 必须是布尔值`);
  }
  if (c.failedMember !== undefined && (typeof c.failedMember !== "string" || c.failedMember.length === 0)) {
    throw new Error(`team case ${c.id} failedMember 必须是非空字符串`);
  }
  if (c.failTool !== undefined && (typeof c.failTool !== "string" || c.failTool.length === 0)) {
    throw new Error(`team case ${c.id} failTool 必须是非空字符串`);
  }
  // 失败隔离的注入点必须成对声明：只给其一无法定位「谁的工具抛错」，会导致断言静默落空。
  if ((c.failedMember === undefined) !== (c.failTool === undefined)) {
    throw new Error(`team case ${c.id} 的 failedMember 与 failTool 必须成对声明`);
  }
}

/**
 * 按 mode 交叉校验期望字段（数据集设计错误的加载期拦截）。
 *
 * @param c 已通过结构校验的 case。
 */
function assertCaseSemantics(c: TeamEvalCase): void {
  const memberNames = new Set((c.members ?? []).map((member) => member.name));

  switch (c.mode) {
    case "dispatch":
      if (!c.expectedSends?.length) {
        throw new Error(`dispatch case ${c.id} 缺少 expectedSends（编排成功必须有派发期望）`);
      }
      break;
    case "member_not_found": {
      if (!c.expectedSends?.length) {
        throw new Error(`member_not_found case ${c.id} 缺少 expectedSends`);
      }
      // 必须至少有一条派发目标既不在预置成员里、也不在期望 spawn 集里，否则该 case 不构成负例。
      const spawnNames = new Set((c.expectedSpawns ?? []).map((member) => member.name));
      const hasGhost = c.expectedSends.some((send) => !memberNames.has(send.recipient) && !spawnNames.has(send.recipient));
      if (!hasGhost) {
        throw new Error(`member_not_found case ${c.id} 的 expectedSends 未指向不存在的成员`);
      }
      break;
    }
    case "over_budget":
      if (c.maxTokensTotal === undefined && c.maxCostPerMember === undefined) {
        throw new Error(`over_budget case ${c.id} 必须至少配置 maxTokensTotal 或 maxCostPerMember`);
      }
      if (!c.expectedSends?.length) {
        throw new Error(`over_budget case ${c.id} 缺少 expectedSends（护栏必须有真实派发才会触发）`);
      }
      break;
    case "permission_deny":
      if (!c.expectedPermission?.deniedTools?.length && !c.expectedPermissionDenials?.length) {
        throw new Error(`permission_deny case ${c.id} 缺少 expectedPermission.deniedTools / expectedPermissionDenials`);
      }
      break;
    case "concurrency":
      if ((c.maxConcurrentMembers ?? 1) < 2) {
        throw new Error(`concurrency case ${c.id} 的 maxConcurrentMembers 必须 ≥2 才构成并发观测`);
      }
      if (!c.expectedSends?.length) {
        throw new Error(`concurrency case ${c.id} 缺少 expectedSends`);
      }
      break;
    case "failure_isolation": {
      // 必须精确到「哪个成员 + 哪个工具」：否则 runner 只能猜，猜不中就会静默变成 done。
      if (!c.failedMember || !c.failTool) {
        throw new Error(
          `failure_isolation case ${c.id} 必须声明 failedMember + failTool（旧写法 failSubagentExecution 不足以定位注入点）`,
        );
      }
      const target = (c.members ?? []).find((m) => m.name === c.failedMember);
      if (!target) {
        throw new Error(`failure_isolation case ${c.id} 的 failedMember "${c.failedMember}" 不在 members 中`);
      }
      // 该工具必须真的被该成员持有（未授权 = 永远不会被调用 = 注入不会生效 = 静默通过）。
      const granted = target.allowedTools;
      if (granted !== undefined && !granted.includes(c.failTool)) {
        throw new Error(
          `failure_isolation case ${c.id} 的 failTool "${c.failTool}" 不在成员 "${c.failedMember}" 的 allowedTools 中`,
        );
      }
      if (c.expectedSends?.some((s) => s.recipient === c.failedMember) !== true) {
        throw new Error(`failure_isolation case ${c.id} 必须向 failedMember "${c.failedMember}" 派发任务`);
      }
      break;
    }
    default: {
      // 穷尽检查：新增 mode 时必须在此登记语义校验，否则加载期显式报错（避免静默放行）。
      const never: never = c.mode;
      throw new Error(`team case ${c.id} 未登记 mode 语义校验：${String(never)}`);
    }
  }
}

/**
 * 统计 case 的 mode 分布（报告与测试用）。
 *
 * @param cases case 列表。
 * @returns mode → 条数（含 0 条 mode 的键，便于断言「六类全覆盖」）。
 */
export function countTeamCasesByMode(cases: readonly TeamEvalCase[]): Record<TeamEvalMode, number> {
  const counts = {} as Record<TeamEvalMode, number>;
  for (const mode of VALID_MODES) counts[mode] = 0;
  for (const c of cases) counts[c.mode] += 1;
  return counts;
}

/**
 * 解析 team 数据集 JSON 文本（不读盘，便于测试直接喂字符串）。
 *
 * @param json 数据集 JSON 文本。
 * @param source 来源标识（错误消息里定位文件）。
 * @param minCasesOverride 可选 case 数下限覆盖（仍以 §8 的 20 为底线）。
 * @returns 解析后的 team 数据集。
 */
export function parseTeamDataset(json: string, source: string, minCasesOverride?: number): TeamEvalDataset {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`无法解析 team 数据集 ${source}：${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).cases)) {
    throw new Error(`team 数据集 ${source} 缺少 cases 数组`);
  }
  const data = raw as Record<string, unknown>;
  const cases = data.cases as unknown[];

  cases.forEach((c, i) => assertCaseShape(c, i));
  const typed = cases as TeamEvalCase[];

  // 下限取 max(§8 底线, 数据集自带 minCases, 调用方覆盖)——谁都无权把 team 数据集缩到 20 条以下。
  const declared = typeof data.minCases === "number" ? data.minCases : TEAM_DATASET_MIN_CASES;
  const minCases = Math.max(TEAM_DATASET_MIN_CASES, declared, minCasesOverride ?? 0);
  if (typed.length < minCases) {
    throw new Error(`team 数据集 ${source} case 数 ${typed.length} 低于下限 ${minCases}`);
  }

  // id 唯一性：重复 id 会让逐 case 归因（failedMetrics）张冠李戴。
  const seen = new Set<string>();
  for (const c of typed) {
    if (seen.has(c.id)) throw new Error(`team 数据集 ${source} 存在重复 case id：${c.id}`);
    seen.add(c.id);
    assertCaseSemantics(c);
  }

  return {
    schemaVersion: typeof data.schemaVersion === "string" ? data.schemaVersion : "2.0.0",
    datasetVersion: typeof data.datasetVersion === "string" ? data.datasetVersion : "team-v1",
    seed: typeof data.seed === "number" ? data.seed : undefined,
    domain: typeof data.domain === "string" ? data.domain : "ohna",
    minCases,
    cases: typed,
  };
}

/**
 * 加载并校验 team 评测数据集文件。
 *
 * @param path 数据集 JSON 路径（绝对或相对）。
 * @param options 可选 case 数下限覆盖（不得低于 §8 的 20）。
 * @returns 解析后的 team 数据集。
 */
export function loadTeamDataset(path: string, options: { minCases?: number } = {}): TeamEvalDataset {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`无法读取 team 数据集 ${path}：${(err as Error).message}`);
  }
  return parseTeamDataset(text, path, options.minCases);
}
