/**
 * 单个 run 的 Team 接线装配（docs/v2.0/04 §2.2，缺口 B）。
 *
 * 放在这里而不是 `run-manager.ts`：run-manager 已超过单文件行数上限（W0 冻结约束），
 * 新逻辑必须落在 `run/` 下。本模块只做一件事——把一个 run 的「确认闸门 + 事件出口 +
 * 工具池」打包成 `TeamTurn`，并保证收尾时释放绑定；它不持有 run 状态机、不决定终态。
 *
 * 关 / 开两条路径的差异在这里被彻底收敛：
 * - 关：`team` 为 undefined，工具表与 streamFn 由调用方原样使用（行为与接入前一致）；
 * - 开：返回合并了 Team 工具的工具表与共享 traced streamFn。
 */
import {
  SUPERVISOR_AGENT_ID,
  type AgentLoopConfig,
  type StreamFn,
  type TeamState,
} from "@aiagent/agent";
import type { LlmCallRecordDto, LlmWindowDto } from "@aiagent/types";
import type { AgentTool } from "@aiagent/tools";
import type { ServeTeamSession, SubagentRunPayload } from "./team-session.js";
import { createRunTracedStreamFn, createSupervisorLoopStreamFn } from "./trace-stream.js";

/** 宿主侧的 run 事件出口（同步契约）。 */
export interface TeamRunnerEmit {
  /** 子代理四类边界事件（已带 agentId / parentId）。 */
  subagent: (event: SubagentRunPayload) => void;
  /** 主线程与子代理的 LLM 采集记录。 */
  llmCall: (record: LlmCallRecordDto) => void;
}

/** Team 运行封装：`begin` / `release` 成对使用。 */
export interface TeamRunner {
  /** 本次 run 实际注入 loop 的工具表。 */
  tools: readonly AgentTool<any>[];
  /** 本次 run 的 loop streamFn（主线程 = supervisor 身份）。 */
  streamFn: StreamFn;
  /** 释放 run 绑定（run 收尾时调，幂等）。 */
  release(): void;
}

/** Team 运行封装（单 run）。 */
export class TeamRunBinding {
  private turn: { tools: readonly AgentTool<any>[]; streamFn: StreamFn; release(): void } | undefined;

  /**
   * @param options.team 开关（false 时不建任何绑定，行为与接入前完全一致）。
   * @param options.session serve 侧 Team 会话（`createServeTeamSession` 的产物）。
   * @param options.base 底层 StreamFn（测试注入 / 缺省 streamSimple）。
   * @param options.window 采集窗口参数（构造 wrapper 时注入）。
   */
  constructor(
    private readonly options: {
      team?: boolean;
      session?: ServeTeamSession;
      base: StreamFn;
      window: LlmWindowDto;
    }
  ) {}

  /**
   * 为一次 run 建立绑定。
   *
   * @param input.runId 本 run 的标识（会话层 run 注册表的键，并发 run 互不覆盖）。
   * @param input.conversationId 本 run 所属会话（用于从注册表取该会话的 controller）。
   * @param input.beforeToolCall 本 run 的确认闸门钩子（子代理与主线程共用）。
   * @param input.emit run 事件出口（同步契约）。
   * @param input.tools 本 run 的实际工具表（会话 workspace 解析产物，不含 Team 工具）。
   * @returns Team 运行封装；开关关闭时返回 `undefined`。
   */
  begin(
    input: {
      runId: string;
      conversationId: string;
      /** 本 run 的快照 Team 开关；缺省回退构造开关（RunManager 单测直接构造时）。 */
      team?: boolean;
      beforeToolCall?: NonNullable<AgentLoopConfig["beforeToolCall"]>;
      emit: TeamRunnerEmit;
    },
    tools: readonly AgentTool<any>[]
  ): TeamRunner | undefined {
    if (!(input.team ?? this.options.team) || !this.options.session) return undefined;
    // 按 conversationId 取该会话的 controller，再在其下以 runId 登记独立绑定。转发器
    // 只在本会话的绑定表内路由，绝不跨 conversation 串流（spec §7.4）。
    const turn = this.options.session.getOrCreate(input.conversationId).beginRun(
      {
        runId: input.runId,
        ...(input.beforeToolCall ? { beforeToolCall: input.beforeToolCall } : {}),
        // 事件与主线程共用同一 sequence：emitTypedFrame 在第一个 await 之前同步分配，
        // 因此子代理边界事件与紧随其后的主线程事件不会乱序（异步失败一律吞掉）。
        emit: (event) => input.emit.subagent(event),
        emitLlmCall: (record) => input.emit.llmCall(record),
      },
      tools
    );
    this.turn = turn;
    return {
      tools: turn.tools,
      streamFn: turn.streamFn,
      release: () => this.release(),
    };
  }

  /** 释放绑定：teamSession 是进程级单例，残留绑定点会让后续子代理事件投进本 run。 */
  release(): void {
    const turn = this.turn;
    this.turn = undefined;
    turn?.release();
  }

  /**
   * 团队状态读取器（`getTeamState` 的第一来源，按 conversationId 取该会话 controller）。
   *
   * 返回「按 conversationId 解析 controller 的读取器」而非单一全局读取器：每个会话
   * 独立持有 controller（成员跨轮保留），成本投影按 run 增量时必须回到**本 run 所属会话**
   * 的当前成员用量，不能取全局最后一个活跃会话（spec §7.4 禁止 last-active 路由）。
   *
   * @param conversationId 会话 id（绑定 controller 实例的闭包键）。
   * @returns 读取器；开关关闭或未注入 session 时 undefined（由组合根注入项兜底）。
   */
  getTeamStateFor(conversationId: string): (() => TeamState) | undefined {
    if (!this.options.team || !this.options.session) return undefined;
    return () => this.options.session!.getOrCreate(conversationId).getTeamState();
  }
}

/**
 * 主线程 loop 的 streamFn：`createRunTracedStreamFn` + supervisor 身份转发。
 *
 * 纯组合，不新建第二种构造顺序：window 注入与 observer 转发的唯一实现在 `trace-stream.ts`。
 *
 * @param base 底层 StreamFn。
 * @param sink 采集记录出口（同步契约）。
 * @param window 窗口参数（构造时注入）。
 * @returns 带采集标记的 StreamFn。
 */
export function createSupervisorTracedStreamFn(
  base: StreamFn,
  sink: (record: LlmCallRecordDto) => void,
  window: LlmWindowDto
): StreamFn {
  return createSupervisorLoopStreamFn(
    createRunTracedStreamFn(base, sink, window),
    SUPERVISOR_AGENT_ID
  );
}
