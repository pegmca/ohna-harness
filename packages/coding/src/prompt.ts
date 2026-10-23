/**
 * 编码模式系统提示词装配。
 *
 * 该逻辑原先位于 `apps/ohna-cli/src/mode.ts`，Phase 1 下沉到 `@aiagent/coding`：
 * 提示词模板与项目上下文读取同属「编码域知识」，ohna-cli 与 serve
 * 装配都应复用同一份，而不是各 app 复制一段文案（文案漂移会让不同入口的 Agent 行为不一致）。
 *
 * 边界：本模块不向 stdout/stderr 写任何内容；上下文读取失败时通过 `onContextError`
 * 回调交给调用方决定如何提示（CLI 打 warning，serve 可静默或记日志）。
 */
import { loadProjectContext } from "./context/project-context.js";

/** buildCodingSystemPrompt 的可选行为配置。 */
export interface BuildCodingSystemPromptOptions {
	/**
	 * 项目上下文读取失败时的回调（错误对象原样透传）。
	 * 缺省静默降级：上下文是增强项，不是启动前置条件。
	 */
	onContextError?: (error: unknown) => void;
}

/**
 * 编码助手系统提示词的固定部分：明确「先读后改、改完必验证、不得编造、路径不出工作区」。
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
 * 构造编码模式系统提示词：固定模板 + 项目上下文（AGENTS.md / DESIGN.md / scripts / git 状态）。
 *
 * 降级语义：`loadProjectContext` 抛错或返回空内容时只返回模板，异常交给 `onContextError`；
 * 绝不因上下文缺失而阻断 Agent 启动。
 *
 * @param cwd 工作区根目录（绝对路径）。
 * @param options 失败回调等可选配置。
 * @returns 可直接注入 agentLoop 的系统提示词。
 */
export async function buildCodingSystemPrompt(
	cwd: string,
	options?: BuildCodingSystemPromptOptions,
): Promise<string> {
	const template = codingSystemPromptTemplate(cwd);
	try {
		const projectContext = await loadProjectContext(cwd);
		if (typeof projectContext === "string" && projectContext.trim().length > 0) {
			return `${template}\n\n## 项目上下文\n${projectContext}`;
		}
	} catch (error) {
		options?.onContextError?.(error);
	}
	return template;
}
