/**
 * serve 托管 run 的 Team 接线（docs/v2.0/04 §2.2，缺口 B）。
 *
 * 为什么需要本模块：`run-manager.ts` 只跑单层 `agentLoop`，而 Team wiring 在 v2.0 之前
 * 仅存在于 CLI（`runtime/team-wiring.ts`），导致 web 端 Team 场景不可达。v2.0 起 TeamController
 * **唯一归本模块**（CLI 组合根不再自建第二个 controller，`--no-team` 经 `hostOhnaWeb` 透传为
 * `createOhnaServer({ team })`）——同一工具表因此只有一份 controller、一份 team 成本来源。
 *
 * 桌面迁移期（spec §7.4）的关键改造：**不再按整个 runtime 进程共享一个 controller**，而是
 * 按 `conversationId` 持有独立 controller，成员跨轮保留；每次 run 建立独立执行绑定，转发器
 * 按该 conversation 的「当前活跃 run」路由，**不使用 AsyncLocalStorage 隐式推断归属**，也
 * 不跨 conversation 串流。
 *
 * 四条硬边界（W0 冻结约束 + 内核契约 + §7.4）：
 * 1. **controller 按 conversationId 持有，且不依赖构造时序**：`onSubagentEvent` /
 *    `beforeToolCall` / `streamFn` 都是**构造期读取**的选项（`controller.ts` 一次性取
 *    `options.streamFn`），没有 per-run 参数通道。因此每个 conversation 只建一个 controller，
 *    注入的是**构造期就固定**的稳定转发器——转发器内部按调用时刻查该 conversation 的活跃绑定，
 *    绝不替换 controller 已持有的对象。
 * 2. **每个 conversation 至多一个 active run（全局约束）**：子代理只可能在当前 conversation
 *    的唯一活跃 run 内被派发，故转发器路由到「该 conversation 当前登记的活跃 run」在语义上
 *    等价于 §7.4 要求的「按 runId 精确路由」，且无需把 runId 透传进 agent 内核。跨 conversation
 *    的 controller 完全独立，故子代理事件 / 权限 / 成本绝不串到别的 conversation。
 * 3. **权限闸门单一实例**：确认闸门按 run 建 hook（AskAdapter 闭包需要 runId 才能广播
 *    `confirmation_requested`）。无任何活跃绑定（run 已终态 / 超时兜底 / 从未登记）时
 *    **fail-closed**：宁可拒绝子代理操作，也不静默绕过审批。
 * 4. **事件归属**：`onSubagentEvent` 只转发四类边界事件，与主线程事件**共用同一 sequence**
 *    （由宿主 sink 分配）。本模块不打 sequence、不落盘、不广播。采集归因由内核薄转发完成
 *    （子代理 `llm_call.agentId` 由 `team/controller.ts` 的 `runMember` 在进入 `agentLoop`
 *    前补 `observer.agentId` = 成员名；主线程由 `trace-stream.ts` 转发为 `supervisor`）。
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

/** 单个 conversation 的 Team 会话句柄（按 conversationId 持有，成员跨轮保留）。 */
export interface ConversationTeamSession {
  /** 待并入 supervisor 工具表的 TeamCreate / SendMessage。 */
  teamTools: AgentTool<any>[];
  /** 团队状态读取器：run 级 `getTeamState` 的来源（成员跨轮保留）。 */
  getTeamState(): TeamState;
  /**
   * 开始一次 run 的 Team 会话：登记确认闸门 hook、事件出口与**本 run 实际工具池**，
   * 返回该 run 合并后的工具表与主线程 streamFn。
   *
   * 并发语义：每个 conversation 至多一个 active run（全局约束），故绑定按 runId 登记后，
   * 转发器路由到「该 conversation 当前活跃 run」，等价于按 runId 精确归属，且不跨 conversation
   * 串流。先结束的 run 调 `release()` 只摘自己那一项，绝不会误清其它 conversation 的绑定。
   *
   * @param binding run 上下文（runId + 闸门 hook + 事件出口）。
   * @param tools 本 run 的工具表（会话 workspace 解析产物，不含 Team 工具）。
   * @returns 本 turn 的工具表、streamFn 与释放函数。
   */
  beginRun(binding: RunBinding, tools: readonly AgentTool<any>[]): TeamTurn;
}

/** 跨 conversation 的 Team 会话注册表（spec §7.4）。 */
export interface ServeTeamSession {
  /**
   * 取得（或缓存创建）某 conversation 的 Team 会话句柄。
   *
   * 每个 conversation 独立持有 controller：成员与消息跨 run/跨轮保留，且不同 conversation
   * 的 Team 成员、工具池、权限、事件与成本互不共享。
   *
   * @param conversationId 会话 id。
   * @returns 该 conversation 的 Team 会话句柄（同一 id 返回缓存实例）。
   */
  getOrCreate(conversationId: string): ConversationTeamSession;
  /**
   * 释放某 conversation 的 Team 会话（会话生命周期结束 / 归档时调用）。
   *
   * 只销毁该 conversation 的 controller 与其下所有 run 绑定；不影响其它 conversation。
   * 不抛错：重复 release 或释放不存在的 conversation 均为安全空操作。
   *
   * @param conversationId 会话 id。
   */
  release(conversationId: string): void;
}

/** 活跃 run 绑定（含本 run 的工具池）。 */
type ActiveBinding = RunBinding & { tools: readonly AgentTool<any>[] };

/**
 * 创建 serve 侧 Team 会话注册表（spec §7.4）：按 conversationId 持有独立 controller。
 *
 * 为什么不是进程级单例、也不是每 run 一个 controller：成员表与消息队列是**会话级**概念
 * （supervisor 上轮建的成员下轮仍可派发），`cost_summary` 的团队基线快照也依赖 controller
 * 存活；但「整个进程共享一个 controller」会让跨 conversation 的子代理事件 / 权限 / 成本互相串流
 * （即被 §7.4 禁止的「按最后登记的活跃 run 路由」）。折中是**按 conversationId** 持有 controller：
 * 同会话跨轮保留成员，跨会话完全隔离；每个 conversation 内部至多一个 active run（全局约束），
 * 其转发器按「当前活跃 run」「精确路由」，绝不跨 conversation 串流，也不依赖 last-active 全局槽。
 *
 * 时序契约：**无任何隐含顺序要求**。每个 conversation 的 controller 在首次 `getOrCreate`
 * 时创建，注入的 `streamFn` / `beforeToolCall` / `onSubagentEvent` 都是稳定转发器（闭包查
 * 该 conversation 的活跃绑定），因此 controller 早于或晚于首个 `beginRun` 都不影响事件
 * 归属与权限判定。
 *
 * @param options 模型、底层 streamFn、采集窗口与工具池快照。
 * @returns 跨 conversation 的 Team 会话注册表（`getOrCreate` / `release`）。
 */
export function createServeTeamSession(options: ServeTeamSessionOptions): ServeTeamSession {
  const baseStreamFn: StreamFn = options.streamFn ?? (streamSimple as StreamFn);

  /** 每个 conversation 独立持有的会话级 Team 会话（含其下 runId → 绑定的精确路由表）。 */
  const conversations = new Map<string, ConversationTeamSession>();

  /**
   * 创建一个 conversation 的 Team 会话（内部构造，不暴露给外部）。
   *
   * 每个 conversation 拥有自己的 controller（成员跨轮保留），其下的 run 绑定按 `runId`
   * 登记；由于全局约束保证每个 conversation 至多一个 active run，转发器读取「当前活跃绑定」
   * 即等价于按 runId 精确归属——且不跨 conversation 串流。
   *
   * @param conversationId 会话 id（仅用于诊断与边界归属）。
   * @returns 该 conversation 的 Team 会话句柄。
   */
  const createConversationSession = (conversationId: string): ConversationTeamSession => {
    /** 本 conversation 内的活跃 run 绑定（按 runId 登记；每个 conversation 至多一个 active run）。 */
    const bindings = new Map<string, ActiveBinding>();

    /**
     * 取得本 conversation 当前应承接子代理事件 / 闸门判定的绑定。
     *
     * 每个 conversation 至多一个 active run（全局约束），故取「当前登记的唯一活跃绑定」；
     * 无活跃 run 时 undefined（调用方按 fail-closed 处理）。这**不是**进程级 last-active 槽，
     * 不会跨 conversation 串流。
     *
     * @returns 绑定；无活跃 run 时 undefined。
     */
    const activeBinding = (): ActiveBinding | undefined => {
      let current: ActiveBinding | undefined;
      for (const binding of bindings.values()) current = binding;
      return current;
    };

    /**
     * 权限闸门转发器（K3 策略继承的 serve 版）：按调用时刻查本 conversation 的活跃绑定。
     *
     * 无活跃绑定时 fail-closed：run 已被 `cancel` / `shutdown` 超时兜底标记终态而子代理仍在飞时，
     * 其后续工具调用会被拒绝并回喂结构化原因——这是**预期**行为（宁可失败也不越权）。
     */
    const beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]> = async (
      context,
      signal
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
      identity: SubagentEventIdentity
    ): void => {
      const binding = activeBinding();
      if (!binding) return;
      const parentId =
        identity.parentId ?? (event.type === "agent_start" ? event.parentId : undefined);
      try {
        binding.emit({
          ...event,
          agentId: identity.agentId,
          ...(parentId !== undefined ? { parentId } : {})
        } as SubagentRunPayload);
      } catch {
        // 事件丢失优于编排中断：转发链路故障不得让子代理失败（§2.1）。
      }
    };

    /**
     * 子代理采集 sink：按调用时刻查本 conversation 的活跃绑定。
     *
     * 这是**构造期固定**的稳定转发器，controller 捕获后永不替换——不依赖「controller 必须在
     * 首个 beginRun 之后创建」这种脆弱时序。无活跃 run 时丢弃（此时子代理不应还在跑）。
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
      // 初始池只是构造期快照；beginRun 会在每次 run 前替换为实际工具池（见 beginRun）。
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
      beginRun(binding, tools) {
        const record: ActiveBinding = { ...binding, tools };
        // 先删再插：同一 run 重复 beginRun 时移到「最新」位置，避免陈旧绑定抢占路由。
        // 配合全局约束（每 conversation 至多一个 active run），这恰好是「按 runId 精确路由」。
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
            // 只摘自己那一项：并发 run 下不会误清别的 conversation 的绑定。
            if (bindings.get(binding.runId) === record) bindings.delete(binding.runId);
          },
        };
      },
    };
  };

  return {
    getOrCreate(conversationId: string): ConversationTeamSession {
      let session = conversations.get(conversationId);
      if (!session) {
        session = createConversationSession(conversationId);
        conversations.set(conversationId, session);
      }
      return session;
    },
    release(conversationId: string): void {
      conversations.delete(conversationId);
    },
  };
}
