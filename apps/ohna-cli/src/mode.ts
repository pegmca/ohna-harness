/**
 * 运行模式（composition root 的策略层）：把 `--mode` 映射成「系统提示词 + 回合预算」。
 *
 * 边界说明：模式只决定「提示词说些什么、给多少回合预算、用哪套工具注册表」，
 * agentLoop 内核与工具实现完全不感知模式——这正是「运输层可替换、能力靠注册表组合」的体现。
 */
import { buildCodingSystemPrompt } from "@aiagent/coding";

/** CLI 运行模式：research 为金融研究（默认，保持历史行为），coding 为编码助手。 */
export type CliMode = "research" | "coding";

/** research 模式的单轮回合预算（历史值 8，未改动）。 */
const RESEARCH_MAX_TURNS = 8;

/** coding 模式的单轮回合预算：编码任务常需「读 → 改 → 跑验证 → 自愈」多轮展开。 */
const CODING_MAX_TURNS = 24;

/** 系统提示词：定义金融研究助手的行为边界，不含任何占位或演示性文本。 */
const RESEARCH_SYSTEM_PROMPT =
  "你是沉浸式金融研究助手，基于真实大模型回答上市公司财务、行情与公告相关问题。" +
  "需要数据时调用工具获取；若数据工具未配置，应如实说明无法取得实时数据，不要编造数字。";

/**
 * 按模式解析单轮回合预算：coding 任务回合更多（需自愈循环），research 保持历史值。
 *
 * @param mode 运行模式。
 * @returns 该模式允许的最大回合数。
 */
export function resolveMaxTurns(mode: CliMode): number {
  return mode === "coding" ? CODING_MAX_TURNS : RESEARCH_MAX_TURNS;
}

/**
 * 按模式解析系统提示词：research 返回固定金融提示词；
 * coding 在编码提示词后追加项目上下文（AGENTS.md / DESIGN.md / package.json scripts / git status）。
 *
 * 项目上下文读取失败时不阻断启动（例如非 git 仓库、文件缺失），仅降级为不带上下文的提示词，
 * 保证 CLI 的行为可预期——上下文是增强项，不是启动前置条件。
 *
 * @param mode 运行模式。
 * @param cwd 工作区根目录。
 * @returns 可直接注入 agentLoop 的系统提示词。
 */
export async function resolveSystemPrompt(mode: CliMode, cwd: string): Promise<string> {
  if (mode !== "coding") return RESEARCH_SYSTEM_PROMPT;

  // 提示词与上下文装配已下沉到 @aiagent/coding；CLI 只保留「失败时打 warning」这一运输层职责。
  return buildCodingSystemPrompt(cwd, {
    onContextError: (error) => {
      process.stderr.write(
        `项目上下文读取失败（已降级为无上下文运行）：${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });
}
