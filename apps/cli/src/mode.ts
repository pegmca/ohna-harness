/**
 * 运行模式（composition root 的策略层）：把 `--mode` 映射成「系统提示词 + 回合预算」。
 *
 * 边界说明：模式只决定「提示词说些什么、给多少回合预算、用哪套工具注册表」，
 * agentLoop 内核与工具实现完全不感知模式——这正是「运输层可替换、能力靠注册表组合」的体现。
 */
import { loadProjectContext } from "@aiagent/coding";

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
 * 编码助手系统提示词的固定部分：明确「先读后改、改完必验证、不得编造、路径不出工作区」。
 * 项目上下文（AGENTS.md / DESIGN.md / scripts / git 状态）由 loadProjectContext 动态注入，
 * 让模型开箱即用项目约定，同时限制它只能在工作区内行动。
 *
 * @param cwd 工作区根目录（绝对路径）。
 * @returns 编码模式的系统提示词骨架。
 */
function codingSystemPromptTemplate(cwd: string): string {
  return [
    "你是运行在终端里的编码助手，工作目录（唯一可写作用域）为：" + cwd,
    "行为约束：",
    "1. 先读后改：修改任何文件前先用 read / grep / find / ls 确认现状，禁止凭猜测写文件。",
    "2. 路径边界：所有文件读写与命令执行都限定在上述工作目录内；越界请求会被底层拒绝，不要尝试绕过。",
    "3. 改完必须验证：写完或改完代码后，必须运行项目自带的验证命令（如 pnpm --filter <包> typecheck / build / test），" +
      "并以真实输出为准继续修复；验证未通过就如实说明，绝不能声称已经通过。",
    "4. 不得编造：不能虚构文件内容、命令输出或执行结果，一切以工具真实返回为依据。",
    "5. 最小改动：只改完成任务必需的文件与行，不做无关重构与格式化。",
    "6. 写文件与执行命令需要用户确认；被拒绝时改为只读方案或向用户说明原因。",
    "7. 最终回复用中文，简要说明改动的文件、执行的验证命令与真实结果。",
  ].join("\n");
}

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

  const template = codingSystemPromptTemplate(cwd);
  try {
    const projectContext = await loadProjectContext(cwd);
    if (typeof projectContext === "string" && projectContext.trim().length > 0) {
      return `${template}\n\n## 项目上下文\n${projectContext}`;
    }
  } catch (error) {
    // 结构化降级：不让上下文读取异常冒泡到 CLI 启动流程。
    process.stderr.write(
      `项目上下文读取失败（已降级为无上下文运行）：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return template;
}
