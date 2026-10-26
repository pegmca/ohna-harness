/**
 * serve 托管 run 的 Team 接线（docs/v2.0/04 §2.2，缺口 B）。
 *
 * 为什么需要本模块：`run-manager.ts` 只跑单层 `agentLoop`，而 Team wiring 在 v2.0 之前
 * 仅存在于 CLI（`runtime/team-wiring.ts`），导致 web 端 Team 场景不可达。v2.0 起 TeamController
 * **唯一归本模块**（CLI 组合根不再自建第二个 controller，`--no-team` 经 `hostOhnaWeb` 透传为
 * `createOhnaServer({ team })`）——同一工具表因此只有一份 controller、一份 team 成本来源。
 *
 * 五条硬边界（W0 冻结约束 + 内核契约）：
 * 1. **一个 controller，进程级，且不依赖构造时序**：`onSubagentEvent` / `beforeToolCall` /
 *    `streamFn` 都是**构造期读取**的选项（`controller.ts:100` 一次性取 `options.streamFn`），
 *    没有 per-run 参数通道。因此 controller 只建一次，注入的是**构造期就固定**的稳定转发器
 *    ——转发器内部按调用时刻查 run 注册表，绝不替换 controller 已持有的对象。
 * 2. **run 注册表而非单槽**：web 端多会话并发是既有能力。`beginTurn` 把绑定登记进
 *    `Map<runId, binding>`，转发器路由到「最后登记的活跃 run」（子代理只可能在当前活跃 run
 *    内被派发）；`release()` 只摘自己那一项，绝不会误清别人的绑定。
 * 3. **权限闸门单一实例**：serve 的确认闸门按 run 建 hook（AskAdapter 闭包需要 runId 才能
 *    广播 `confirmation_requested`）。无任何活跃绑定（run 已终态 / 超时兜底 / 从未登记）时
 *    **fail-closed**：宁可拒绝子代理操作，也不静默绕过审批。
 * 4. **事件归属**：`onSubagentEvent` 只转发四类边界事件，与主线程事件**共用同一 sequence**
 *    （由宿主 sink 分配）。本模块不打 sequence、不落盘、不广播。
 * 5. **采集归因由内核薄转发完成，serve 不做区间推导**：子代理 `llm_call` 的 `agentId`
 *    由 `team/controller.ts` 的 `runMember` 在进入 `agentLoop` 前薄转发 `observer.agentId`
 *    = `deriveSubagentIdentity(member).agentId`（即成员名）得到；主线程同理由
 *    `trace-stream.ts` 转发为 `supervisor`。两条链各持一条 wrapper、各自一条 `callIndex`
 *    序列，因此两个 agent 的 `callIndex` 会重号，这是预期形态。
 *    消费侧（docs/v2.0/04 §2.3）**按键归属、不按 sequence 区间切割**：`TurnSpan` 以
 *    `(agentId, turnIndex)` 为键，`[startSeq, endSeq]` 只作滚动锚点——子代理事件与主线程
 *    交错是常态，区间推导会把工具结果算到错误的 turn 上。
 */
import type { AgentEvent, AgentLoopConfig, TeamState } from "@aiagent/agent";
import { createTeamController } from "@aiagent/agent";
import type { StreamFn } from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import type { LlmCallRecordDto, LlmWindowDto } from "@aiagent/types";
import { streamSimple } from "@aiagent/ai";
import { createRunTracedStreamFn, createSupervisorLoopStreamFn } from "./trace-stream.js";

/** 可转发的子代理边界事件：只取 AgentEvent 的四类生命周期边界。 */
export type SubagentBoundaryEvent = Extract<
  AgentEvent,
  { type: "agent_start" | "agent_end" | "turn_start" | "turn_end" }
>;

/** 子代理事件的身份归属（`parentId` 只在 `agent_start` 上有值）。 */
export interface SubagentEventIdentity {
  agentId: string;
  parentId?: string;
}

/** 转发给 run 事件 sink 的载荷：事件本体 + 身份（§2.2 第 2 条）。 */
export type SubagentRunPayload = SubagentBoundaryEvent & {
  agentId: string;
  parentId?: string;
};

/** 一个 run 的绑定上下文：确认闸门 hook 与事件出口。 */
export interface RunBinding {
  /** 该 run 的主线程权限钩子（serve confirm-gate 产物）；缺省表示该 run 无闸门（测试 / 只读装配）。 */
  beforeToolCall?: NonNullable<AgentLoopConfig["beforeToolCall"]>;
  /** runId：并发 run 的注册键（同一 run 重复登记即替换）。 */
  runId: string;
  /**
   * 子代理边界事件出口：宿主负责分配 sequence 并写 run 事件流。
   * **同步契约**（与 `LlmTraceSink` 一致）：实现方同步入队，抛错被本模块吞掉。
   */
  emit: (event: SubagentRunPayload) => void;
  /**
   * LLM 采集记录出口（主线程与子代理共用同一 wrapper）。
   * 单独的字段而非复用 `emit`：两类载荷形状无关，宿主按类型分派会把签名撑成联合类型。
   */
  emitLlmCall: (record: LlmCallRecordDto) => void;
}

/** 一次 run 内可用的 Team 句柄（execute 期间持有，收尾时 release）。 */
export interface TeamTurn {
  /** 该 run 的工具表 + Team 工具（合并后的新数组）。 */
  tools: readonly AgentTool<any>[];
  /** 主线程使用的 streamFn（子代理走会话级稳定转发器）。 */
  streamFn: StreamFn;
  /** 结束本 turn 的绑定（可重复调用）。 */
  release(): void;
}

/** Team 会话的依赖。 */
export interface ServeTeamSessionOptions {
  /** 当前模型（TeamCreate 未指定 model 时作为默认模型）。 */
  model: Model<"openai-completions">;
  /** 底层 StreamFn（缺省 `streamSimple`；测试注入桩）。 */
  streamFn?: StreamFn;
  /** 采集窗口参数（`LlmCallRecordDto.window`），与主线程 wrapper 同源。 */
  window: LlmWindowDto;
  /** 子代理可继承的工具池（初始快照；每个 run 由 `beginTurn` 覆盖为本 run 的实际工具池）。 */
  tools?: readonly AgentTool<any>[];
}

/** serve 侧 Team 会话句柄。 */
export interface ServeTeamSession {
  /** 待并入 supervisor 工具表的 TeamCreate / SendMessage。 */
  teamTools: AgentTool<any>[];
  /** 团队状态读取器：run 级 `getTeamState` 的 fallback 来源。 */
  getTeamState: () => TeamState;
  /**
   * 开始一次 run 的 Team 会话：登记确认闸门 hook、事件出口与**本 run 实际工具池**，
   * 返回该 run 合并后的工具表与主线程 streamFn。
   *
   * 并发语义：绑定按 `runId` 登记，不互相覆盖；转发器总是路由到**最后登记的活跃 run**
   * （子代理只可能在当前活跃 run 内被派发）。先结束的 run 调 `release()` 只摘自己那一项。
   *
   * @param binding run 上下文（runId + 闸门 hook + 事件出口）。
   * @param tools 本 run 的工具表（会话 workspace 解析产物，不含 Team 工具）。
   * @returns 本 turn 的工具表、streamFn 与释放函数。
   */
  beginTurn(binding: RunBinding, tools: readonly AgentTool<any>[]): TeamTurn;
}

/** 活跃 run 绑定（含本 run 的工具池）。 */
type ActiveBinding = RunBinding & { tools: readonly AgentTool<any>[] };

/**
 * 创建 serve 侧 Team 会话（进程级单例：一个 `RunManager` 一个 controller）。
 *
 * 为什么不是每 run 一个 controller：成员表与消息队列是**会话级**概念（supervisor 上轮建的
 * 成员下轮仍可派发），`cost_summary` 的团队基线快照也依赖 controller 存活。代价是
 * `onSubagentEvent` 没有 per-run 通道，故用 run 注册表桥接（见文件头第 1、2 条）。
 *
 * 时序契约：**无任何隐含顺序要求**。controller 在本函数返回前创建，注入的
 * `streamFn` / `beforeToolCall` / `onSubagentEvent` 都是稳定转发器（闭包查注册表），
 * 因此 controller 早于或晚于首个 `beginTurn` 都不影响事件归属与权限判定。
 *
 * @param options 模型、底层 streamFn、采集窗口与工具池快照。
 * @returns Team 工具、状态读取器与 `beginTurn`。
 */
export function createServeTeamSession(options: ServeTeamSessionOptions): ServeTeamSession {
  const baseStreamFn: StreamFn = options.streamFn ?? (streamSimple as StreamFn);

  /** 活跃 run 绑定（插入顺序 = 登记顺序，路由取最后一个）。 */
  const bindings = new Map<string, ActiveBinding>();

  /**
   * 取得当前应承接子代理事件 / 闸门判定的绑定：最后登记的活跃 run。
   *
   * @returns 绑定；无活跃 run 时 undefined（调用方按失败关闭处理）。
   */
  const activeBinding = (): ActiveBinding | undefined => {
    let last: ActiveBinding | undefined;
    for (const binding of bindings.values()) last = binding;
    return last;
  };

  /**
   * 权限闸门转发器（K3 策略继承的 serve 版）：按调用时刻查注册表。
   *
   * 无活跃绑定时 fail-closed：run 已被 `cancel` / `shutdown` 超时兜底标记终态而子代理仍在飞时，
   * 其后续工具调用会被拒绝并回喂结构化原因——这是**预期**行为（宁可失败也不越权）。
   */
  const beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]> = async (
    context,
    signal,
  ) => {
    const hook = activeBinding()?.beforeToolCall;
    if (!hook) return { block: true, reason: "权限闸门未就绪，已拒绝子代理操作。" };
    return hook(context, signal);
  };

  /**
   * 子代理边界事件转发：同步入队（宿主 sink 契约同步），抛错吞掉。
   *
   * `parentId` 取事件自带值（仅 `agent_start` 有）；`identity` 是冗余保险（防事件形状漂移）。
   */
  const onSubagentEvent = (
    event: SubagentBoundaryEvent,
    identity: SubagentEventIdentity,
  ): void => {
    const binding = activeBinding();
    if (!binding) return;
    const parentId =
      identity.parentId ?? (event.type === "agent_start" ? event.parentId : undefined);
    try {
      binding.emit({
        ...event,
        agentId: identity.agentId,
        ...(parentId !== undefined ? { parentId } : {}),
      } as SubagentRunPayload);
    } catch {
      // 事件丢失优于编排中断：转发链路故障不得让子代理失败（§2.1）。
    }
  };

  /**
   * 子代理采集 sink：按调用时刻查注册表。
   *
   * 这是**构造期固定**的稳定转发器，controller 捕获后永不替换——不依赖「controller 必须在
   * 首个 beginTurn 之后创建」这种脆弱时序。无活跃 run 时丢弃（此时子代理不应还在跑）。
   */
  const subagentSink = (record: LlmCallRecordDto): void => {
    const binding = activeBinding();
    if (!binding) return;
    try {
      binding.emitLlmCall(record);
    } catch {
      // 采集失败不得打断编排（观测是旁路）。
    }
  };

  /**
   * controller 的子代理 streamFn：一次构造、终生复用。
   *
   * 与主线程的 streamFn **不是同一个对象**（两个 wrapper 各有 callIndex 计数器），
   * 但同源同参（同一个 base、同一个 window、同一个 sink 路由），因此归因口径一致。
   */
  const subagentStreamFn = createRunTracedStreamFn(baseStreamFn, subagentSink, options.window);

  const controller = createTeamController({
    // 初始池只是构造期快照；beginTurn 会在每次 run 前替换为实际工具池（见 beginTurn）。
    availableTools: [...(options.tools ?? [])],
    defaultModel: options.model,
    streamFn: subagentStreamFn,
    beforeToolCall,
    onSubagentEvent,
    // 用量回收（成本可观测性）：controller 只在配置了 `budget` 时才创建护栏钩子，
    // 而钩子正是 `member.usage` 的唯一累加点（budget.ts 的 createMemberStopHook）。
    // 不传 budget 时 `member.usage` 恒为 undefined，`cost_summary.team` 段会静默消失。
    // 这里传一份**无上限**配置：四个上限与 deadline 全部缺省 → createBudgetGuard 恒 true、
    // 钩子永不返回 true（不改变任何控制流），只让用量沿既有产线流到团队成本段。
    // 若将来要把预算从宿主下传，应在此按 run 透传，而不是在 controller 内造第二套口径。
    budget: {},
  });

  const teamToolNames = new Set(controller.tools.map((tool) => tool.name));

  return {
    teamTools: controller.tools,
    getTeamState: () => controller.getTeamState(),
    beginTurn(binding, tools) {
      const record: ActiveBinding = { ...binding, tools };
      // 先删再插：同一 run 重复 beginTurn 时移到「最新」位置，避免陈旧绑定抢占路由。
      bindings.delete(binding.runId);
      bindings.set(binding.runId, record);
      return {
        // Team 工具只补一次：调用方传入的工具表若已含同名项，以 Team 版本为准。
        tools: [...tools.filter((tool) => !teamToolNames.has(tool.name)), ...controller.tools],
        // 主线程身份恒为 supervisor 根节点：单智能体与 Team 场景同口径（04 §1.3）。
        streamFn: createSupervisorLoopStreamFn(
          createRunTracedStreamFn(baseStreamFn, binding.emitLlmCall, options.window),
          "supervisor",
        ),
        release() {
          // 只摘自己那一项：并发 run 下不会误清别人的绑定。
          if (bindings.get(binding.runId) === record) bindings.delete(binding.runId);
        },
      };
    },
  };
}
