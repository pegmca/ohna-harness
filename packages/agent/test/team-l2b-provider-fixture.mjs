/**
 * L2b「真 provider 驱动 + mock 工具副作用」测试夹具（docs/v2.0/03-team-eval.md §6.3）。
 *
 * 本文件不是测试文件（不以 `.test.mjs` 结尾，不被 node --test 收集），只提供两条能力：
 *
 * 1. `detectRealProvider()`：按 `@aiagent/ai` 同一套 profile 遍历规则（`resolveActiveModelFromEnv`）
 *    判断当前环境是否有真实 LLM 凭据。**没有凭据时不做任何伪造**：调用方显式 `t.skip()`
 *    并在原因里写明「无 provider 凭据，跳过真 provider 档」——绝不静默通过（03 §4 硬约束）。
 * 2. `createRealStreamFn(active, limits)`：返回一个**未包装的**真 `streamFn`——内部直接调
 *    `@aiagent/ai` 的 `streamSimple`（与 controller 缺省路径同一函数），只注入与「模型输出」
 *    无关的传输层参数：`apiKey`（凭据）、`temperature`、`maxTokens`、`timeoutMs`。
 *
 * ## 传输层假设（显式声明，排查真 provider 档失败时先看这里）
 *
 * - **`maxTokens` 必须有值**：openai-completions 的请求体只有在 options 带 `maxTokens` 时才写
 *   `max_tokens` / `max_completion_tokens` 字段（见 `packages/ai/src/api/openai-completions/request.ts`
 *   的 `buildParams`：`if (options?.maxTokens) params[compat.maxTokensField] = options.maxTokens`），
 *   因此缺省值 64 是**本夹具自己选的上限**，不是网关行为。若某个网关关闭 `max_tokens`
 *   （要求省略该字段）或要求更大上限，调用方必须显式传 `limits.maxTokens`；不传时回复可能被截断到
 *   64 token，表现为 `summary` 变短或 stopReason 为 "length"（控制流断言仍成立，但内容不完整）。
 * - **`temperature: 0`**：只压非确定性，不改变「模型选什么工具」——断言面不依赖内容（§6.3 第 1 条）。
 * - **`timeoutMs` 缺省 20s**：仅本夹具的测试用超时，生产缺省为 10 分钟；不可达网关会在 20s 内
 *   以结构化失败收尾，而不是挂住 CI。
 *
 * 严禁在此加入任何「回放固定 assistant 消息」的逻辑（那正是 v2.0 删掉的 `createMockStreamFn`）。
 */
import { streamSimple, resolveActiveModelFromEnv } from "@aiagent/ai";

/**
 * 无凭据时的 skip 原因（唯一的文案来源）。
 *
 * key 模式与 `apps/ohna-cli/src/eval/team/adapter.ts` 的 `detectProviderCredentials` 对齐，
 * 统一使用通配 `AIAGENT_LLM_API_KEY_*`（实际 profile 后缀为 DEEPSEEK / OPENROUTER / BRIDGE_AI 等），
 * 避免报告里出现两套写法不同的 key 名。
 */
export const PROVIDER_SKIP_REASON = "无 provider 凭据（AIAGENT_LLM_API_KEY_* 未配置），跳过真 provider 档";

/**
 * 探测当前环境是否存在可用的真实 provider 凭据。
 *
 * 判定完全复用生产同一条规则（`resolveActiveModelFromEnv`），避免测试与生产「一个入口能识别、
 * 另一个识别不出」的漂移。探测为空时返回 `reason`，由调用方 `t.skip(reason)`。
 *
 * @returns 有凭据时返回 `{ active }`；否则返回 `{ reason }`（可直接作为 skip 原因）。
 */
export function detectRealProvider() {
  const active = resolveActiveModelFromEnv();
  if (!active || !active.apiKey || !active.model) return { reason: PROVIDER_SKIP_REASON };
  // 防御：provider 必须是 openai-completions 兼容链路（本仓库 resolveActiveModelFromEnv 只产出该 api）。
  if (active.model.api !== "openai-completions") {
    return { reason: `${PROVIDER_SKIP_REASON}（仅支持 openai-completions 兼容 provider）` };
  }
  return { active };
}

/**
 * 构造一个真 `streamFn`（直通 `streamSimple`，零 mock）。
 *
 * @param active `detectRealProvider()` 返回的 ActiveModel（含 model 与 apiKey）。
 * @param limits 传输层参数（与内容无关）：温度、输出 token 上限、单请求超时；见文件头假设。
 * @returns 满足 `TeamControllerOptions.streamFn` 契约的真 provider 流式函数。
 */
export function createRealStreamFn(active, limits = {}) {
  const temperature = limits.temperature ?? 0;
  // 显式给值才会写 max_tokens 字段（见文件头「传输层假设」）；需要省略该字段的网关
  // 不能复用本夹具的缺省值，必须让调用方自己决定。
  const maxTokens = limits.maxTokens ?? 64;
  const timeoutMs = limits.timeoutMs ?? 20_000;
  return (model, context, options) =>
    // apiKey 来自环境（凭据注入），不是消息内容；其余 options 由 loop 原样透传（signal 等）。
    streamSimple(model, context, { ...options, apiKey: active.apiKey, temperature, maxTokens, timeoutMs });
}
