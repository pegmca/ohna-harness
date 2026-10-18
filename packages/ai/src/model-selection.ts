/**
 * 从环境变量选择「当前可用的真实模型」。
 *
 * 该逻辑原先位于 `apps/ohna-cli/src/harness.ts`，Phase 1 下沉到 `@aiagent/ai`：
 * ohna-cli 与未来的 serve / ohna-api 装配需要同一套 profile 遍历规则，若留在 app 层，
 * 每个入口都要复制一份（容易出现「一个入口识别 bridge_ai、另一个不识别」的漂移）。
 *
 * 边界：只依赖包内 provider 工厂与 `process.env`，不引用 @aiagent/agent 或任何 app。
 */
import type { Model } from "./types.js";
import { createOpenAiCompatibleRuntime } from "./providers/env-runtime.js";

/**
 * 候选 provider profile 与其缺省 baseUrl。
 * deepseek / openrouter 使用各自网关；bridge_ai 由环境变量覆盖 baseUrl（缺省留空，需显式配置）。
 */
const PROFILES: ReadonlyArray<readonly [string, string]> = [
	["deepseek", "https://api.deepseek.com/v1"],
	["openrouter", "https://openrouter.ai/api/v1"],
	["bridge_ai", ""],
];

/** 解析出的可用真实模型与凭据。 */
export interface ActiveModel {
	model: Model<"openai-completions">;
	apiKey: string;
}

/**
 * 列出当前环境已配置齐全（apiKey + model 就绪）的 profile 名称。
 *
 * 供 CLI 的 `/model` 命令展示「可用 profile 与当前生效项」；与 resolveActiveModelFromEnv
 * 消费同一套遍历规则，保证两个出口看到的结果一致（不会出现「能切换却列不出来」的漂移）。
 *
 * @returns 已配置的 profile 名列表（按候选顺序）。
 */
export function listAvailableModelProfiles(): string[] {
	return PROFILES.map(([profile, baseUrl]) => ({
		profile,
		result: createOpenAiCompatibleRuntime(profile, baseUrl),
	}))
		.filter((entry) => entry.result.runtime)
		.map((entry) => entry.profile);
}

/**
 * 解析当前环境可用的真实模型：遍历各 profile 调 createOpenAiCompatibleRuntime，
 * 收集配置齐全（apiKey + model 均就绪）的 runtime。
 * 若指定了 modelFlag，则只在对应 profile 已配置时返回它；否则返回第一个可用 profile。
 * 全部未配置或指定 profile 不存在时返回 null，由调用方打印错误并以非零码退出（绝不回退 mock）。
 *
 * @param modelFlag 可选的 --model 值，用于锁定某个 profile。
 * @returns 可用模型或 null。
 */
export function resolveActiveModelFromEnv(modelFlag?: string): ActiveModel | null {
	const all = PROFILES.map(([profile, baseUrl]) => ({
		profile,
		result: createOpenAiCompatibleRuntime(profile, baseUrl),
	}));

	const valid = all
		.filter((entry) => entry.result.runtime)
		.map((entry) => ({ profile: entry.profile, ...entry.result.runtime! }));

	if (valid.length === 0) return null;

	if (modelFlag) {
		const chosen = valid.find((entry) => entry.profile === modelFlag);
		return chosen ?? null;
	}

	return valid[0];
}
