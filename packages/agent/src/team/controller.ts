/**
 * TeamController：多智能体 Supervisor 编排的运行时核心（P3）。
 *
 * 关键设计：
 * - Supervisor 本身是一个普通 `agentLoop`；本 controller 把两个原语作为 `AgentTool`
 *   注册进 supervisor 的 `context.tools`：`TeamCreate`（建子代理）、`SendMessage`（派发任务）。
 * - 每个子代理 = 一次独立 `agentLoop(prompts, ctx, config)`：天然独立 context + EventStream +
 *   独立 token 预算（零新增 loop 代码，复用内核）。
 * - 上下文隔离 + 摘要回收：子代理只回写 `summary` / `artifacts` 到 team 状态，主上下文
 *   不接触其探索噪声（subagent 第一性价值，对齐 Claude Code Subagent / pi subagent）。
 * - 失败隔离：子代理抛错 / agent_end.error 捕获为结构化 `SubagentResult.error`，以普通文本
 *   回传 supervisor（isError:false），主循环不崩溃。
 */
import { streamSimple } from "@aiagent/ai";
import { agentLoop } from "../agent-loop.js";
import { defaultConvertToLlm } from "../convert.js";
import type { AgentEvent, AgentMessage, AgentLoopConfig, StreamFn } from "../types.js";
import type { AgentTool, AgentToolResult } from "@aiagent/tools";
import type {
  SubagentResult,
  TeamControllerOptions,
  TeamCreateParams,
  TeamEvent,
  TeamMember,
  TeamMessage,
  TeamState,
} from "./types.js";
import type { Api, Model } from "@aiagent/ai";
import { createSendMessageTool, createTeamCreateTool } from "./tools.js";

/** TeamController 公开接口（orchestrator 之后会 re-export）。 */
export interface TeamController {
  /** 注册进 supervisor `context.tools` 的两个原语（TeamCreate + SendMessage）。 */
  readonly tools: AgentTool[];
  /** 返回 team 状态的只读快照（浅拷贝，调用方不应 mutate 实时引用）。 */
  getTeamState(): TeamState;
  /** 返回人类可读的团队状态字符串（Agent View）。 */
  getTeamView(): string;
  /** 是否存在某成员。 */
  hasMember(name: string): boolean;
  /** 直接注册一个成员（不经由工具调用，供 presets 预置用）。 */
  createMember(params: TeamCreateParams & { modelObject?: Model<Api> }): TeamMember;
  /**
   * 向指定成员派发任务并同步运行其 subagent，回收摘要。
   * 失败返回结构化 error，不抛异常（失败隔离）。
   */
  runMember(name: string, content: string, signal?: AbortSignal): Promise<SubagentResult>;
}

/** 生成一个简单唯一 id（学习版，不引入额外依赖）。 */
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从子代理的最终消息集中提取「摘要 + 产物引用」。
 * 摘要取最后一条 assistant 文本；产物收集所有 toolResult 的工具名 + 短摘要。
 *
 * @param messages 子代理 agentLoop 最终回写的消息集（含 prompt 与工具结果）。
 * @returns 摘要文本与产物引用列表。
 */
function extractSummary(messages: AgentMessage[]): { summary: string; artifacts: string[] } {
  let summary = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text) {
        summary = text;
        break;
      }
    }
  }
  const artifacts = messages
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 120);
      return `${m.toolName}:${text || "(空)"}`;
    });
  return { summary: summary || "(子代理无文本输出)", artifacts };
}

/**
 * 创建 TeamController（Supervisor 编排层）。
 *
 * @param options 可用工具池、默认 model、可解析 model、可注入的 streamFn/convertToLlm。
 * @returns 持有 TeamState 并暴露 TeamCreate/SendMessage 两个工具的 controller。
 */
export function createTeamController(options: TeamControllerOptions): TeamController {
  const state: TeamState = {
    members: new Map<string, TeamMember>(),
    inboundQueues: new Map<string, TeamMessage[]>(),
    events: [],
  };

  const streamFn: StreamFn = options.streamFn ?? (streamSimple as StreamFn);
  const convertToLlm = options.convertToLlm ?? defaultConvertToLlm;

  /** 解析成员应使用的工具子集：按 allowedTools 名从可用池过滤（权限最小化）。 */
  function resolveTools(member: TeamMember): AgentTool[] {
    const pool = options.availableTools ?? [];
    if (!member.allowedTools || member.allowedTools.length === 0) return pool;
    const allowed = new Set(member.allowedTools);
    return pool.filter((t) => allowed.has(t.name));
  }

  /** 解析成员应使用的 Model：显式对象优先，其次按 id 经 resolveModel，否则 defaultModel。 */
  function resolveModel(params: TeamMemberSeed): TeamMember["model"] {
    if (params.modelObject) return params.modelObject;
    if (params.model) {
      const m = options.resolveModel?.(params.model);
      if (!m) {
        throw new Error(`unknown_model: resolveModel 未能解析 model id "${params.model}"`);
      }
      return m;
    }
    return options.defaultModel;
  }

  /** 把一条跨 agent 消息投入接收方 inbound 队列并投影事件。 */
  function enqueueMessage(from: string, to: string, content: string): TeamMessage {
    const message: TeamMessage = { id: nextId("msg"), from, to, content, timestamp: Date.now() };
    const queue = state.inboundQueues.get(to) ?? [];
    queue.push(message);
    state.inboundQueues.set(to, queue);
    state.events.push({ type: "message_sent", timestamp: message.timestamp, member: to, detail: from });
    return message;
  }

  function recordEvent(event: TeamEvent): void {
    state.events.push(event);
  }

  /** createMember 的可选扩展：允许直接传入已解析的 Model 对象（presets 用）。 */
  type TeamMemberSeed = TeamCreateParams & { modelObject?: Model<Api> };

  function createMember(params: TeamMemberSeed): TeamMember {
    if (state.members.has(params.name)) {
      throw new Error(`duplicate_member: 成员 "${params.name}" 已存在`);
    }
    const member: TeamMember = {
      name: params.name,
      role: params.role,
      model: resolveModel(params),
      allowedTools: params.tools,
      systemPrompt: params.systemPrompt,
      status: "idle",
    };
    state.members.set(member.name, member);
    state.inboundQueues.set(member.name, []);
    recordEvent({ type: "member_created", timestamp: Date.now(), member: member.name, detail: member.role });
    return member;
  }

  /**
   * 运行某成员的 subagent（一次独立 agentLoop），回收摘要到 team 状态。
   * 顺序执行（学习版）；未来并发可在此套 mapWithConcurrencyLimit 风格的 worker 池
   * （见 「与 durable runs 结合」）。
   */
  async function runMember(name: string, content: string, signal?: AbortSignal): Promise<SubagentResult> {
    const member = state.members.get(name);
    if (!member) {
      return {
        member: name,
        status: "failed",
        summary: "",
        artifacts: [],
        error: { code: "member_not_found", message: `成员 "${name}" 不存在` },
      };
    }

    enqueueMessage("supervisor", name, content);
    member.status = "running";
    recordEvent({ type: "member_started", timestamp: Date.now(), member: name });

    // 上下文隔离：子代理持独立 messages，只以委派内容为 prompt 起手。
    // 注意：prompt 只通过 agentLoop 的 prompts 参数注入一次（agentLoop 会把它并入
    // context.messages），不要再预先塞进 subContext.messages，否则任务会在子代理上下文里重复出现。
    const taskMessage: AgentMessage = { role: "user", content, timestamp: Date.now() };
    const subContext = {
      systemPrompt: member.systemPrompt ?? `你是团队中的「${member.role}」成员。`,
      messages: [] as AgentMessage[],
      tools: resolveTools(member),
    };
    const subConfig: AgentLoopConfig = { model: member.model, convertToLlm };

    try {
      const stream = agentLoop([taskMessage], subContext, subConfig, signal, streamFn);

      // 消费事件流：捕获 agent_end.error（错误即数据，不抛），其余仅投影。
      let endError: { code: string; message: string } | undefined;
      for await (const event of stream) {
        if (event.type === "agent_end" && event.error) {
          endError = { code: event.error.code, message: event.error.message };
        }
      }
      const messages = await stream.result();
      const { summary, artifacts } = extractSummary(messages);

      // 失败判定：agent_end.error（兜底收尾）或最终 assistant 的 stopReason 为 error/aborted。
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const aborted =
        endError || (lastAssistant && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted"));
      if (aborted) {
        const error =
          endError ??
          (lastAssistant
            ? { code: "subagent_failed", message: `stopReason: ${lastAssistant.stopReason}` }
            : { code: "subagent_failed", message: "unknown" });
        member.status = "failed";
        member.summary = summary;
        member.artifacts = artifacts;
        recordEvent({ type: "member_failed", timestamp: Date.now(), member: name, detail: error.message });
        return { member: name, status: "failed", summary, artifacts, error };
      }

      member.status = "done";
      member.summary = summary;
      member.artifacts = artifacts;
      recordEvent({ type: "member_completed", timestamp: Date.now(), member: name });
      return { member: name, status: "done", summary, artifacts };
    } catch (caught) {
      // 兜底失败隔离：任何意外异常都收敛为结构化错误，主循环不崩溃。
      const error = { code: "subagent_failed", message: caught instanceof Error ? caught.message : String(caught) };
      member.status = "failed";
      member.summary = member.summary ?? "";
      recordEvent({ type: "member_failed", timestamp: Date.now(), member: name, detail: error.message });
      return { member: name, status: "failed", summary: "", artifacts: [], error };
    }
  }

  /** 只读快照：浅拷贝成员与队列，避免调用方直接 mutate 实时状态。 */
  function getTeamState(): TeamState {
    const members = new Map<string, TeamMember>();
    for (const [k, v] of state.members) members.set(k, { ...v });
    const inboundQueues = new Map<string, TeamMessage[]>();
    for (const [k, v] of state.inboundQueues) inboundQueues.set(k, v.slice());
    return { members, inboundQueues, events: state.events.slice() };
  }

  function hasMember(name: string): boolean {
    return state.members.has(name);
  }

  const tools: AgentTool[] = [
    createTeamCreateTool({ createMember, runMember }),
    createSendMessageTool({ createMember, runMember }),
  ];

  return {
    tools,
    getTeamState,
    // 0 参便捷方法：对当前快照调用模块级 getTeamView(state) 渲染视图。
    getTeamView: () => getTeamView(getTeamState()),
    hasMember,
    createMember,
    runMember,
  };
}

/**
 * 把 TeamState 渲染成人类可读状态字符串（Agent View / 看板）。纯函数，便于测试与复用。
 *
 * @param state team 状态快照。
 * @returns 多行状态文本。
 */
export function getTeamView(state: TeamState): string {
  const lines: string[] = [`Team: ${state.members.size} members`];
  for (const [name, member] of state.members) {
    const tools = member.allowedTools ? member.allowedTools.join(",") || "(无)" : "(全量)";
    lines.push(`- ${name} [${member.status}] ${member.role} | model=${member.model.id} tools=${tools}`);
    if (member.summary) lines.push(`   摘要: ${member.summary.slice(0, 80)}`);
  }
  return lines.join("\n");
}

