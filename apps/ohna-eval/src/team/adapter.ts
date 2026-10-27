/**
 * team 评测的「工具副作用出口」适配层（docs/v2.0/03-team-eval.md §3/§4）。
 *
 * ## 红线（本文件存在的全部理由）
 *
 * §4 定论：**允许 mock「工具副作用出口」，禁止 mock「模型输出」**。
 * 因此本文件**没有、也不允许有**任何 streamFn 替身：
 * - ❌ 没有 `createMockStreamFn`（回放固定 assistant 消息）；
 * - ❌ 没有「按 expectedToolCalls 发工具调用」的确定性 provider（`../adapter.ts` 的
 *   `createOfflineStreamFn` 属于 coding 评测的既有形态，team 域**明确不复用**——它会让
 *   「模型选了什么」变成测试自己写死的输入，用固定模型输出测编排决策 = 踩红线，§4.3）；
 * - ✅ 只有把 write / edit / bash 等有副作用工具的 `execute` 收敛为确定性返回值。
 *
 * ## 与 coding adapter 的区别
 *
 * coding 的 `createMockCodingTools` 让写操作落真实临时工作区（因为它断言「文件后果」）；
 * team 只断言「控制流走通、工具被调用了几次、护栏是否触发」，**不断言文件内容**，
 * 因此 team 的工具副作用直接收敛为固定返回值：零落盘、零子进程、零污染。
 *
 * 判据（§4.1）：mock 的是「动作发生后对外部世界的效果」，不是「模型决定做什么」。
 */

import type { AgentTool } from "@aiagent/tools";
import type { BeforeToolCallContext, BeforeToolCallResult } from "@aiagent/agent";

/**
 * 确认钩子签名（与 `@aiagent/agent` 权限契约 `BeforeToolCallContext` / `BeforeToolCallResult` 同构）。
 * 定义在宿主侧的 `ConfirmHook` 原属 CLI 权限层；本包是独立评测包，不依赖 CLI，故在此声明同构类型，
 * 不引入对 `@aiagent/ohna-cli` 的耦合。
 */
export type ConfirmHook = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/**
 * 真实工具骨架工厂（`@aiagent/coding`）。
 *
 * 用动态 import 而非顶层静态 import：L1/L2a 与纯函数指标（工具子集复算、凭据探测）
 * 不跑 agentLoop，不应因为「评测域被加载」就把整条编码工具链拉进模块图。
 *
 * @param cwd 工作区根。
 * @returns 真实编码工具数组（Promise）。
 */
async function loadCodingTools(cwd: string): Promise<AgentTool[]> {
  const coding = await import("@aiagent/coding");
  return coding.createCodingToolRegistry(cwd);
}

/** team 评测默认可用工具池（子代理只能是其子集）。 */
export const DEFAULT_TEAM_TOOL_POOL: readonly string[] = ["read", "write", "edit", "bash"];

/** `createSideEffectMockTools` 的入参。 */
export interface CreateSideEffectMockToolsOptions {
  /** 工作区根（仅用于构造工具骨架；mock 的 execute 不落盘）。 */
  cwd: string;
  /** 可用工具名（缺省 `DEFAULT_TEAM_TOOL_POOL`）。 */
  pool?: readonly string[];
  /** 可选观测数组：每次调用 push 一条记录（控制流证据）。 */
  invocations?: TeamToolInvocation[];
  /** 需要抛错的工具名（失败隔离用：模拟工具异常被回喂模型）。 */
  failTools?: readonly string[];
  /**
   * 失败注入真的抛出时的回调（每抛一次调一次）。
   *
   * 存在的理由：`failure_isolation` 类别必须能证明「异常确实发生了」，
   * 而不是「声明了注入、但该工具从未被调用」（后者会让断言静默落空）。
   */
  onFail?: (tool: string) => void;
}

/** 每次被 mock 工具调用记录的观测条目（供「工具被调了几次」的控制流断言）。 */
export interface TeamToolInvocation {
  /** 工具名。 */
  tool: string;
  /** 本次调用入参（快照）。 */
  args: Record<string, unknown>;
}

/**
 * 创建「副作用被收敛为固定返回」的编码工具集。
 *
 * 只替换 `execute`，**保留 `name` / `description` / `label` / `parameters` / `effect`**——
 * 契约字段不变意味着：权限闸门仍按 `effect` 裁决（write/edit/bash 为 mutate），
 * 模型看到的工具 schema 与生产完全一致，差异只有「写盘不发生」。
 *
 * @param options 工作区根 / 工具池 / 观测数组 / 注入失败的工具名。
 * @returns 副作用被 mock 的工具数组（字段契约与真实工具一致；工具骨架懒加载故为 Promise）。
 */
export async function createSideEffectMockTools(options: CreateSideEffectMockToolsOptions): Promise<AgentTool[]> {
  const wanted = new Set(options.pool ?? DEFAULT_TEAM_TOOL_POOL);
  const failing = new Set(options.failTools ?? []);
  const registry = await loadCodingTools(options.cwd);

  return registry
    .filter((tool) => wanted.has(tool.name))
    .map((tool) => {
      const mocked: AgentTool = {
        ...tool,
        async execute(_toolCallId, params: Record<string, unknown>) {
          // 先记账再返回：即便工具被设计为抛错，调用事实也必须可观测（控制流证据）。
          options.invocations?.push({ tool: tool.name, args: { ...params } });
          if (failing.has(tool.name)) {
            options.onFail?.(tool.name);
            throw new Error(`team-eval 注入的工具失败：${tool.name}`);
          }
          return {
            content: [{ type: "text", text: `[team-eval mock] ${tool.name} 已执行（副作用被收敛为固定结果）` }],
            details: { mocked: true, tool: tool.name },
          };
        },
      } as AgentTool;
      return mocked;
    });
}

/**
 * 从完整工具池里按「允许集合」筛出成员可用工具（与 controller 的 `resolveTools` 同语义）。
 *
 * 独立实现一份的原因：本函数用于**评测侧独立复算**「成员本应拿到哪些工具」，
 * 与被测的 controller 内部实现互为对照——若 controller 的过滤逻辑回归，
 * 两侧不一致会让 `teamPermissionInheritanceCorrectness` 直接 0 分（而不是两边一起错）。
 *
 * @param pool 可用工具名池。
 * @param allowedTools 成员声明允许的工具名；`undefined` 表示未声明（全量），`[]` 表示零工具。
 * @returns 成员实际应得的工具名列表（保序）。
 */
export function resolveExpectedTools(pool: readonly string[], allowedTools: readonly string[] | undefined): string[] {
  if (allowedTools === undefined) return [...pool];
  const allowed = new Set(allowedTools);
  return pool.filter((tool) => allowed.has(tool));
}

/**
 * 创建「继承闸门」确定性裁决器（T-L1/T-L2a/T-L2b 的权限继承证据源）。
 *
 * 依据 `AgentTool.effect` 单一事实源：`read` 直接放行，`mutate` 走允许集合裁决。
 * 裁决规则（评测专用，非生产策略）：
 * - `deniedTools` 中宣告的工具 → 拒绝（fail-closed 断言：期望拒绝却未触发即判失败）；
 * - 其余 mutate → 放行（「放行后执行抛错」的失败隔离由 mock 工具自己实施，不在权限层伪造拒绝）。
 *
 * @param options.deniedTools 必须被拒绝的工具名。
 * @returns 与 `AgentLoopConfig.beforeToolCall` 同签名的钩子（可直接注入 team controller）。
 */
export function createInheritanceGate(options: { deniedTools?: readonly string[] } = {}): ConfirmHook {
  const denied = new Set(options.deniedTools ?? []);
  return async (context, signal) => decideWithoutSignal(denied, context, signal);
}

/**
 * 继承闸门的裁决内核（与 `createInheritanceGate` 共用，供 T-L1/T-L2a 的确定性自证调用）。
 *
 * 抽出来的唯一理由：让「权限继承是否正确」能在**不跑子代理**的档位里被主动证明
 * （探测一次闸门，看它是否按 `effect` + 工具子集拒绝），而不必等真模型恰好去调 write。
 *
 * @param denied 待拒绝工具集合（命中即消耗一条）。
 * @param context 权限钩子上下文（含成员自己的工具子集）。
 * @param signal run 级取消信号。
 * @returns 拒绝裁决或 undefined（放行）。
 */
async function decideWithoutSignal(
  denied: Set<string>,
  context: Parameters<ConfirmHook>[0],
  signal?: AbortSignal,
): Promise<{ block: true; reason: string } | undefined> {
  if (signal?.aborted) return { block: true, reason: "Run 已取消，操作未执行。" };
  const toolName = context.toolCall.name;
  const effect = context.context.tools?.find((tool) => tool.name === toolName)?.effect ?? "mutate";
  // read 类工具不产生外部副作用，按 effect 单一事实源直接放行。
  if (effect === "read") return undefined;
  if (denied.has(toolName)) {
    denied.delete(toolName);
    return { block: true, reason: `team-eval 继承闸门拒绝 ${toolName}（断言 fail-closed）` };
  }
  // 失败隔离用的「工具抛错」由 mock 工具的 execute 实施（见 createSideEffectMockTools）：
  // 闸门对它放行，让异常发生在工具副作用出口，而不是在权限层伪造一个拒绝。
  return undefined;
}

/**
 * 主动探测继承闸门（T-L1/T-L2a 的确定性自证，零模型）。
 *
 * 用**与成员完全相同的工具子集**构造钩子上下文，再对期望被拒的工具调一次闸门：
 * 拒绝即证明「继承通道 + effect 裁决 + 工具子集」三件事在该档位下成立。
 *
 * @param options.deniedTools 期望被拒绝的工具名（取第一条探测）。
 * @param options.grantedTools 成员被授予的工具名（构造上下文里的工具子集）。
 * @param options.effectOf 工具名 → 副作用声明（缺省 mutate，与 AgentTool 的保守缺省一致）。
 * @returns 探测结果；没有期望拒绝工具时返回 undefined。
 */
export async function probeInheritanceGate(options: {
  deniedTools: readonly string[];
  grantedTools: readonly string[];
  effectOf?: (tool: string) => "read" | "mutate" | undefined;
}): Promise<{ tool: string; blocked: boolean; reason?: string } | undefined> {
  const tool = options.deniedTools[0];
  if (!tool) return undefined;
  const effectOf = options.effectOf ?? (() => "mutate" as const);
  const tools = options.grantedTools.map((name) => ({ name, effect: effectOf(name) }) as unknown as AgentTool);
  const gate = createInheritanceGate({ deniedTools: [tool] });
  const verdict = await gate({ toolCall: { name: tool }, context: { tools } } as Parameters<ConfirmHook>[0]);
  return verdict
    ? { tool, blocked: true, reason: verdict.reason }
    : { tool, blocked: false, reason: `闸门放行了 ${tool}（期望 fail-closed）` };
}

/**
 * 把「继承闸门」包成宿主 `ConfirmHook` 形态（`beforeToolCall` 的同构签名）。
 *
 * team controller 与 harness 共用同一条权限通道（K3 策略继承）：评测里用同一个钩子同时
 * 作为 supervisor 与子代理的闸门，从而让「子代理是否真的继承到闸门」成为可观测事实。
 *
 * @param denials 拒绝记录数组：每次拒绝 push 工具名（供 `TeamCaseEvidence.deniedTools`）。
 * @param options.deniedTools 必须被拒绝的工具名。
 * @returns `ConfirmHook` 形态的钩子。
 */
export function createRecordingGate(
  denials: string[],
  options: { deniedTools?: readonly string[] } = {},
): ConfirmHook {
  const gate = createInheritanceGate({ deniedTools: options.deniedTools });
  return async (context, signal) => {
    const verdict = await gate(context, signal);
    if (verdict) denials.push(context.toolCall.name);
    return verdict;
  };
}

/**
 * 判断当前环境是否具备真 provider 凭据（决定 T-L2b / T-L4 是执行还是显式 skip）。
 *
 * 判定口径与 `@aiagent/ai` 的 `resolveActiveModelFromEnv` 一致：遍历 deepseek / openrouter /
 * bridge_ai 三个 profile，任一配置齐全（apiKey + model）即可。不在这里自己拼 key 名——
 * 复用库函数避免「评测认为有凭据、运行期却解析不出模型」的漂移。
 *
 * @param resolveModel 可选注入的解析函数（测试用；缺省懒导入 `@aiagent/ai`）。
 * @returns 凭据可用性与不可用原因（原因会原样写进报告，禁止静默跳过）。
 */
export async function detectProviderCredentials(
  resolveModel?: () => unknown,
): Promise<{ available: boolean; reason?: string }> {
  try {
    const resolved = resolveModel
      ? resolveModel()
      : // 懒导入：T-L1/T-L2a 无凭据也要能跑，不应在模块加载期触碰 provider 解析。
        (await import("@aiagent/ai")).resolveActiveModelFromEnv();
    return resolved ? { available: true } : { available: false, reason: "无 provider 凭据（AIAGENT_LLM_API_KEY_* 未配置）" };
  } catch (error) {
    return {
      available: false,
      reason: `provider 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
