/**
 * 执行地图的跨度投影：Agent 森林 + Turn 列表（纯函数，可单测）。
 *
 * 归属原则（docs/v2.0/04 §2.3，本文件是它的唯一实现）：
 * - **按键归属，不按 sequence 区间切割**。子代理事件嵌在主线程的工具执行之间，
 *   两路事件共用同一条 sequence 序列且必然交错；因此 `turn_start/turn_end` 按
 *   `(agentId, turnIndex)` 认领各自的事件，`[startSeq, endSeq]` 只是首尾锚点，
 *   供 TeamCards「点击滚动」使用，绝不能拿来切区间。
 * - **同键重复出现**（续传重放 / loop 重启）时合并为同一跨度：起始锚点取最小、
 *   结束锚点取最大，不产生第二条 turn。
 * - **单 run 退化为单 root 跨度**：没有 Team 时森林只有 supervisor 一个节点，TeamCards
 *   不会被渲染，单智能体体验不变。
 */
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { resolveAgentId } from "./trace-projection";
import { SUPERVISOR_AGENT } from "./trace-labels";

/** Agent 跨度：按 agent_start/end 归属推导森林；sequence 只记首尾锚点。 */
export interface AgentSpan {
  agentId: string;
  parentId?: string;
  label: string;
  role: string;
  modelId: string;
  startSeq: number;
  endSeq: number;
  children: string[];
  /** 内部标记：是否已收到该 agent 的 `agent_start`（决定起点能否前移）。 */
  declared?: boolean;
  /** 内部标记：是否已收到该 agent 的 `agent_end`（之后的事件不再推进结束锚点）。 */
  closed?: boolean;
}

/** Turn 跨度：按 (agentId, turnIndex) 键归属事件；区间仅作展示参考。 */
export interface TurnSpan {
  agentId: string;
  turnIndex: number;
  startSeq: number;
  endSeq: number;
}

/** 执行地图所需的跨度集合。 */
export interface TraceSpans {
  agents: Map<string, AgentSpan>;
  rootAgentId: string;
  turns: TurnSpan[];
}

/** 事件 payload 的最小结构（web 侧不依赖 @aiagent/agent）。 */
interface SpanEventLike {
  agentId?: string;
  parentId?: string;
  label?: string;
  role?: string;
  modelId?: string;
  turnIndex?: number;
}

/** turn 键的内部编码：agentId 可能含 `:`，用 JSON 数组编码避免分隔符冲突。 */
type TurnKey = string;

/**
 * 生成 (agentId, turnIndex) 的稳定键。
 *
 * @param agentId agent 身份。
 * @param turnIndex turn 序号。
 * @returns 内部键字符串。
 */
export function turnKey(agentId: string, turnIndex: number): TurnKey {
  return JSON.stringify([agentId, turnIndex]);
}

/**
 * 从 `agent_start` payload 摘取身份字段。
 *
 * @param payload 事件 payload。
 * @returns 身份字段（缺失字段为 undefined，由调用方决定兜底）。
 */
function identityOf(payload: unknown): Required<Pick<AgentSpan, "label" | "role" | "modelId">> & {
  agentId?: string;
  parentId?: string;
} {
  const typed = (payload ?? {}) as SpanEventLike;
  return {
    agentId: typeof typed.agentId === "string" && typed.agentId !== "" ? typed.agentId : undefined,
    parentId: typeof typed.parentId === "string" && typed.parentId !== "" ? typed.parentId : undefined,
    label: typeof typed.label === "string" && typed.label !== "" ? typed.label : "",
    role: typeof typed.role === "string" && typed.role !== "" ? typed.role : "",
    modelId: typeof typed.modelId === "string" ? typed.modelId : ""
  };
}

/**
 * 构造 supervisor 根节点的初始跨度（事件流为空或尚未出现 agent_start 时也要有根）。
 *
 * @param seq 锚点 sequence。
 * @returns 根跨度。
 */
function rootSpan(seq: number): AgentSpan {
  return {
    agentId: SUPERVISOR_AGENT.agentId,
    label: SUPERVISOR_AGENT.label,
    role: SUPERVISOR_AGENT.role,
    modelId: "",
    startSeq: seq,
    endSeq: seq,
    children: [],
    declared: false
  };
}

/**
 * 把事件流投影成 Agent 森林与 Turn 列表。
 *
 * `turns` 的排序：按 `startSeq` 升序（= 到达顺序）。Team 场景下主线程与子代理的序号各自
 * 从 0 起算，按 `turnIndex` 排序反而会打乱真实的嵌套顺序（子代理的第 1 轮嵌在主线程第 2 轮
 * 中间），执行地图因此保持「事件发生的先后」。
 *
 * @param events 按 sequence 升序的 run 事件（顺序由数据编排层保证；本函数不排序）。
 * @returns 森林（`Map` 保持首次出现顺序）与 turn 列表：同一 `(agentId, turnIndex)` 重复出现时
 *   **合并为单一跨度**（起点取最早、终点取最晚），不同 agent 的同号 turn 各自独立成条。
 */
export function buildTraceSpans(events: readonly RunStreamEventDtoV2[]): TraceSpans {
  const agents = new Map<string, AgentSpan>();
  const turns: TurnSpan[] = [];
  const turnIndex = new Map<TurnKey, number>();
  /**
   * 各 agent 的「当前 turn」键：turn_start 写入，随后到达的内容事件都归到该 turn。
   * 没有 turn_start 的 agent（理论上不应出现）用 -1 槽位承载，不伪造 turn 序号。
   */
  const currentTurn = new Map<string, number>();

  const touchAgent = (agentId: string, seq: number): AgentSpan => {
    const existing = agents.get(agentId);
    if (existing) {
      // 占位节点（先于 agent_start 出现：compaction / 用户消息归属 supervisor）在真实
      // agent_start 到达前允许把起点前移；一旦 declared，起点就是「该 agent 被创建的时刻」。
      if (!existing.declared) existing.startSeq = Math.min(existing.startSeq, seq);
      // 结束锚点 = agent_end：已收尾的 agent 之后只可能被 run 级事件（如 run_status）路过，
      // 那不代表它还活着，不能把绿色/运行态判断带偏。
      if (!existing.closed) existing.endSeq = Math.max(existing.endSeq, seq);
      return existing;
    }
    const created: AgentSpan = {
      agentId,
      label: agentId,
      role: "",
      modelId: "",
      startSeq: seq,
      endSeq: seq,
      children: [],
      declared: false
    };
    agents.set(agentId, created);
    return created;
  };

  const touchTurn = (agentId: string, index: number, seq: number): void => {
    const key = turnKey(agentId, index);
    const known = turnIndex.get(key);
    if (known !== undefined) {
      const span = turns[known];
      if (span.startSeq > seq) span.startSeq = seq;
      if (span.endSeq < seq) span.endSeq = seq;
      return;
    }
    turnIndex.set(key, turns.length);
    turns.push({ agentId, turnIndex: index, startSeq: seq, endSeq: seq });
  };

  for (const event of events) {
    const payload = (event.payload ?? {}) as SpanEventLike;
    const agentId = resolveAgentId(payload);
    switch (event.type) {
      case "agent_start": {
        const identity = identityOf(payload);
        const existing = agents.get(agentId);
        if (existing) {
          // 重复的 agent_start（重放）：只刷新身份描述与结束锚点，不新建。
          existing.startSeq = event.sequence;
          existing.endSeq = Math.max(existing.endSeq, event.sequence);
          existing.declared = true;
          if (identity.label) existing.label = identity.label;
          if (identity.role) existing.role = identity.role;
          if (identity.modelId) existing.modelId = identity.modelId;
          if (identity.parentId) existing.parentId = identity.parentId;
        } else {
          agents.set(agentId, {
            agentId,
            parentId: identity.parentId,
            label: identity.label || agentId,
            role: identity.role,
            modelId: identity.modelId,
            startSeq: event.sequence,
            endSeq: event.sequence,
            children: [],
            declared: true
          });
        }
        // 子节点登记在父节点下（父可能尚未出现：touchAgent 会先建一个占位节点）。
        if (identity.parentId && identity.parentId !== agentId) {
          const parent = touchAgent(identity.parentId, event.sequence);
          if (!parent.children.includes(agentId)) parent.children.push(agentId);
        }
        break;
      }
      case "turn_start": {
        const index = typeof payload.turnIndex === "number" ? payload.turnIndex : 0;
        currentTurn.set(agentId, index);
        touchTurn(agentId, index, event.sequence);
        touchAgent(agentId, event.sequence);
        break;
      }
      case "turn_end": {
        const index = typeof payload.turnIndex === "number" ? payload.turnIndex : 0;
        currentTurn.set(agentId, index);
        touchTurn(agentId, index, event.sequence);
        touchAgent(agentId, event.sequence);
        // 该 turn 收尾：之后到达的内容事件（终态横条等）不再归入它。
        currentTurn.delete(agentId);
        break;
      }
      case "agent_end": {
        const span = touchAgent(agentId, event.sequence);
        span.endSeq = event.sequence;
        span.closed = true;
        currentTurn.delete(agentId);
        break;
      }
      default:
        // 内容事件（message/tool/llm/context）不改变身份，只把锚点推到该行所属的 turn：
        // 这正是「按键归属」——行归到 (该事件自己的 agentId, 该 agent 的当前 turnIndex)，
        // 而不是用 [startSeq, endSeq] 区间反推（子代理事件必然与主线程交错）。
        // 既没有 turn_start 也没有 turn_end 的内容事件不造 turn：它由执行地图按「最近一次
        // 经过的 turn」承载（见 TurnGroup 的分桶），跨度层不伪造 turn 序号。
        touchAgent(agentId, event.sequence);
        {
          const index = currentTurn.get(agentId);
          if (index !== undefined) touchTurn(agentId, index, event.sequence);
        }
        break;
    }
  }

  const rootAgentId = rootOf(agents);
  if (agents.size === 0) {
    // 空事件流：仍然给出单 root 跨度，执行地图的骨架（Ribbon / TeamCards 判定）不依赖空值分支。
    const span = rootSpan(0);
    agents.set(span.agentId, span);
  }
  const orderedTurns = turns.sort((left, right) => left.startSeq - right.startSeq);
  return { agents, rootAgentId, turns: orderedTurns };
}

/**
 * 求根 agent：优先没有 parentId 的节点；全部都有父时退回 supervisor 常量，
 * 再退回最早的节点（防御父子环导致的无限追溯）。
 *
 * @param agents 已收集的 Agent 跨度。
 * @returns 根节点 agentId。
 */
function rootOf(agents: Map<string, AgentSpan>): string {
  for (const span of agents.values()) {
    if (!span.parentId) return span.agentId;
  }
  if (agents.has(SUPERVISOR_AGENT.agentId)) return SUPERVISOR_AGENT.agentId;
  const first = agents.values().next();
  return first.done ? SUPERVISOR_AGENT.agentId : first.value.agentId;
}

/**
 * 判断是否为 Team run（存在 supervisor 之外的 agent）。
 *
 * @param spans 跨度集合。
 * @returns true 表示需要展示 TeamCards。
 */
export function isTeamRun(spans: TraceSpans): boolean {
  for (const agentId of spans.agents.keys()) {
    if (agentId !== spans.rootAgentId) return true;
  }
  return false;
}

/**
 * 按首次出现顺序列出成员（TeamCards 的渲染顺序）。
 *
 * @param spans 跨度集合。
 * @returns Agent 跨度数组。
 */
export function listAgentSpans(spans: TraceSpans): AgentSpan[] {
  return [...spans.agents.values()];
}
