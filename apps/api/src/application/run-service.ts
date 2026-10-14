/**
 * Run application service（阶段 3 重写）：消费 packages/agent 的 agentLoop 事件流，
 * 逐事件落 run_events（先落库后广播）+ SSE fan-out；消息在 message_end 一次性落
 * messages（run 终态兜底补齐 toolResult 等未落消息）；compaction 由 transformContext
 * 触发后以 role='user'、message_type='compaction' 落表，上下文重建走 listForContext 投影。
 *
 * 与旧版的差异：trace 旁路（traceStore/trace_event 投影）与 report 编排移出 run 主路径
 * （阶段 5 回迁）；终态推导改为消费 agent_end / run_error；会话历史不再内存累积，
 * 每次 run 从 messages 的 listForContext 投影重建（跨进程生效）。
 */
import { agentLoop, createCompactionTransform, defaultConvertToLlm } from "@aiagent/agent";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "@aiagent/agent";
import type { CompactionSettings } from "@aiagent/agent";
import type { AttachmentRepository } from "@aiagent/database";
import type { Message } from "@aiagent/ai";
import {
  compactionStoredContent,
  piMessageToAppendInput,
  storedMessagesToPiMessages,
  type MessageStore,
  type StoredMessage
} from "@aiagent/conversation";
import type {
  AgentRunAcceptedDto,
  AgentRunCreateRequestDto,
  ApiError,
  RunSnapshotDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import {
  createAttachmentRetriever,
  createGroundingTransformContext,
  type AttachmentStore,
  type Citation,
  type CitationRepository,
  type EmbeddingClient,
  type NewCitationInput
} from "@aiagent/rag";
import { redactSensitiveValue } from "@aiagent/trace";
import { createHash, randomUUID } from "node:crypto";
import type { RunEventBus, RunExecutionRegistry, RunScheduler, RunStore } from "./run-ports.js";
import type { ModelRuntime } from "./model-registry.js";

/** 基础 system prompt；附件 grounding 由阶段 5 经 transformContext 回迁。 */
export const BASE_SYSTEM_PROMPT =
  "你是一个金融研究 Agent。可以自主调用提供的工具（财务指标、公告检索、计算器等）完成多步研究，"
  + "拿到工具结果后用中文给出简洁、有依据的回答。"
  + "当用户显式要求研报/研究报告/深度报告（或消息 metadata 带 hint=report）时，必须调用 generate_report 工具完成完整研报流程，"
  + "不得只给文字答复；工具返回后基于其结果总结，并在回答中给出 PDF 下载链接。";

/** hint=report 时追加的硬性指令：report 触发只有「模型自主调用 generate_report」一条路，hint 只做提示约束。 */
export const REPORT_HINT_SYSTEM_INSTRUCTION =
  "本轮用户已显式要求生成研报：你必须调用 generate_report 工具（subject 从用户消息提取），不得跳过工具直接回答。";

/**
 * report 工具装配上下文：由 composition root 注入的 factory 在每个 run 内创建 generate_report 工具，
 * recordEvent 经 publish 先落 run_events 再 SSE 广播（与 grounding 的 recordRetrieval 同一模式）。
 * 取消语义不经此上下文传递：loop 会把 run 级 AbortSignal 作为 execute 参数传给工具。
 */
export interface ReportToolFactoryContext {
  recordEvent: (type: "workflow_node" | "pdf_export", payload: Record<string, unknown>) => Promise<void>;
  userId: string;
  conversationId: string;
  runId: string;
}

/** 单 run 的最大 turn 数预算，防止真实模型陷入工具循环。 */
export const DEFAULT_MAX_TURNS = 8;

/** compaction 注入点：测试用小 contextWindow 触发压缩；summarizer 可替换为 LLM 摘要。 */
export interface RunCompactionOptions {
  contextWindow?: number;
  settings?: Partial<CompactionSettings>;
  summarizer?: (messages: AgentMessage[], previousSummary: string | undefined, signal?: AbortSignal) => Promise<string>;
}

export interface RunServiceDependencies {
  store: RunStore;
  messageStore: MessageStore;
  eventBus: RunEventBus;
  executionRegistry: RunExecutionRegistry;
  scheduler: RunScheduler;
  /** 按目录模型 ID 解析可执行模型 runtime（MockModel 与真实 provider 同路径）。 */
  resolveModel: (modelId: string) => ModelRuntime | undefined;
  hasModel?: (modelId: string) => boolean;
  defaultModelId?: string;
  /** 注入 loop 的工具集（来自 ToolRegistry.list()）；工具选择由模型 function calling 完成。 */
  tools: AgentTool[];
  /** 可选 report 工具工厂：注入后每个 run 额外装配 generate_report（阶段 5 report 回迁，模型自主触发）。 */
  reportToolFactory?: (ctx: ReportToolFactoryContext) => AgentTool;
  /** 附件上传 repository，用于把附件绑定到触发 Run 的用户消息。 */
  attachmentRepository: AttachmentRepository;
  /**
   * 会话级临时附件存储；与 embeddingClient 同时存在时才构造附件 grounding。
   * 缺失时 run 仍可执行，只是不注入附件上下文（对齐"附件可选"语义）。
   */
  attachmentStore?: AttachmentStore;
  /** embedding provider；附件检索需先 embed query，缺失时不启用附件 grounding。 */
  embeddingClient?: EmbeddingClient;
  /** Citation repository，用于把 grounding 检索结果持久化到 assistant message。 */
  citationRepository: CitationRepository;
  /** 单 run 最大 turn 数预算。 */
  maxTurns?: number;
  compaction?: RunCompactionOptions;
  now?: () => Date;
  createId?: (prefix: string) => string;
}

export interface RunApplicationService {
  create(request: AgentRunCreateRequestDto, userId: string): Promise<AgentRunAcceptedDto>;
  get(userId: string, runId: string): Promise<RunSnapshotDtoV2 | undefined>;
  cancel(userId: string, runId: string): Promise<RunSnapshotDtoV2 | undefined>;
  listEvents(userId: string, runId: string, afterSequence: number): Promise<RunStreamEventDtoV2[] | undefined>;
  subscribe(runId: string, listener: (event: RunStreamEventDtoV2) => void): () => void;
  recoverStale(before: string): Promise<number>;
  /** @returns 是否已进入 shutdown，新 Run 必须被拒绝。 */
  isShuttingDown(): boolean;
  /**
   * 优雅关闭：停止接收新 Run，中断在途执行并有限 drain，最后把仍未终态的 Run 标记为 interrupted。
   *
   * @param options.drainMs 等待在途 Run 收尾的最长时间。
   * @returns 被标记为 interrupted 的 Run 数量。
   */
  shutdown(options: { drainMs: number }): Promise<{ interrupted: number }>;
}

/**
 * 创建 Run application service。
 *
 * @param dependencies 可替换端口和 runtime adapter。
 * @returns Run 用例接口。
 */
export function createRunApplicationService(dependencies: RunServiceDependencies): RunApplicationService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? (() => randomUUID());
  // shutdown 期间拒绝新 Run，避免关闭窗口内写入无法 drain 的任务。
  let shuttingDown = false;
  // 同一 conversation 的 run 串行化链：并发创建的同会话 run 按 promise 链排队执行，
  // 避免历史交错与工具结果乱序（跨 conversation 不互相阻塞）。
  const conversationRunChains = new Map<string, Promise<void>>();

  async function recoverStale(before: string): Promise<number> {
    const events = await dependencies.store.recoverStale(before, now().toISOString());
    for (const event of events) dependencies.eventBus.publish(event);
    return events.length;
  }

  /**
   * 把同一会话的 run 挂到该会话的执行链尾部，实现 per-conversation 串行。
   *
   * @param key 会话键（userId:conversationId）。
   * @param task run 执行体。
   * @returns 本次任务的完成 Promise。
   */
  function enqueueConversationRun(key: string, task: () => Promise<void>): Promise<void> {
    const next = (conversationRunChains.get(key) ?? Promise.resolve()).then(task, task);
    conversationRunChains.set(key, next.catch(() => undefined));
    return next;
  }

  /**
   * 先落库后广播：事件只有在 store 事务提交后才进入 SSE fan-out。
   *
   * @param userId 当前用户。
   * @param snapshot 当前 Run 快照（提供 envelope 归属字段）。
   * @param type 事件类型。
   * @param payload 事件载荷（loop 事件本体或生命周期载荷）。
   * @returns 已提交事件；已终态时为 undefined。
   */
  async function publish(
    userId: string,
    snapshot: RunSnapshotDtoV2,
    type: RunStreamEventDtoV2["type"],
    payload: unknown
  ): Promise<RunStreamEventDtoV2 | undefined> {
    const event = await dependencies.store.appendEvent(userId, snapshot.runId, {
      type,
      runId: snapshot.runId,
      requestId: snapshot.requestId,
      conversationId: snapshot.conversationId,
      createdAt: now().toISOString(),
      payload: redactSensitiveValue(payload)
    });
    if (event) dependencies.eventBus.publish(event);
    return event;
  }

  /**
   * 执行一次 run：重建上下文 → 跑 agentLoop → 逐事件落库广播 → 终态补落消息。
   *
   * @param runId Run 标识。
   * @param request 创建请求。
   * @param userId 当前用户。
   * @returns 执行完成 Promise。
   */
  async function execute(runId: string, request: AgentRunCreateRequestDto, userId: string): Promise<void> {
    const controller = dependencies.executionRegistry.get(runId);
    if (!controller) return;
    const snapshot = await dependencies.store.findById(userId, runId);
    if (!snapshot) return;
    try {
      await publish(userId, snapshot, "run_status", { status: "running", message: "Agent 已开始分析研究任务。" });
      const runtime = dependencies.resolveModel(snapshot.modelId);
      if (!runtime) throw new RunModelNotFoundError(snapshot.modelId);

      // 把本次 Run 引用的附件绑定到触发它的用户消息，避免孤儿清理误删用户显式材料。
      if (request.attachmentDocumentIds && request.attachmentDocumentIds.length > 0) {
        for (const documentId of request.attachmentDocumentIds) {
          await dependencies.attachmentRepository.bindMessageByDocumentId(userId, documentId, snapshot.userMessageId);
        }
      }

      // 上下文重建：listForContext 投影（最后一个 compaction + 其后消息）→ pi Message[]。
      const storedHistory = await dependencies.messageStore.listForContext(userId, request.conversationId);
      const history: AgentMessage[] = storedMessagesToPiMessages(storedHistory);
      const prompt: AgentMessage = { role: "user", content: request.message.trim(), timestamp: now().getTime() };

      // 已落库消息按对象引用跟踪：prompt 在 store.create 时已落库；
      // loop 对 assistant / toolResult / steering 消息都会发 message_end（落库点），
      // agent_end 兜底补齐任何未落消息（如流中断）。
      const persistedMessages = new Set<AgentMessage>();
      const persistMessage = async (message: AgentMessage): Promise<StoredMessage | undefined> => {
        if (message.role === "compaction" || persistedMessages.has(message)) return undefined;
        persistedMessages.add(message);
        const mapped = piMessageToAppendInput(message as Message);
        return await dependencies.messageStore.append(userId, {
          ...mapped,
          conversationId: request.conversationId,
          runId,
          createdAt: now().toISOString()
        });
      };
      // 首个 user message_end 即 create 时已落库的 prompt，仅标记不重复写。
      let promptMarked = false;

      // grounding：附件相关片段从**会话级** AttachmentStore 检索后封装为 <untrusted_context> user 消息注入上下文。
      // citation 按“本轮最后一条用户消息时间戳”分槽保存，避免 event stream 异步消费导致 race。
      // 附件存储与 embedding provider 缺一不可：都就绪才构造，否则跳过附件注入（run 本身不受影响）。
      const grounding = dependencies.attachmentStore && dependencies.embeddingClient
        ? createGroundingTransformContext({
            attachmentRetriever: createAttachmentRetriever({
              embeddingClient: dependencies.embeddingClient,
              attachmentStore: dependencies.attachmentStore,
              conversationId: request.conversationId
            }),
            conversationId: request.conversationId,
            attachmentDocumentIds: request.attachmentDocumentIds ?? [],
            ownerUserId: userId,
            recordRetrieval: async (event) => {
              await publish(userId, snapshot, "retrieval", event);
            }
          })
        : undefined;

      // compaction 检测：transformContext 就地写回后，队首出现新 CompactionMessage 即落表
      // （role='user'、message_type='compaction'，content 为已包裹摘要文本）。
      const seenCompactionTimestamps = new Set<number>();
      const compactionTransform = createCompactionTransform({
        model: runtime.model,
        contextWindow: dependencies.compaction?.contextWindow,
        settings: dependencies.compaction?.settings,
        summarizer: dependencies.compaction?.summarizer ?? defaultSummarizer
      });
      const transformContext = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
        const grounded = grounding ? await grounding(messages, signal) : messages;
        const transformed = await compactionTransform(grounded, signal);
        const head = transformed[0];
        if (head?.role === "compaction" && !seenCompactionTimestamps.has(head.timestamp)) {
          seenCompactionTimestamps.add(head.timestamp);
          await dependencies.messageStore.append(userId, {
            conversationId: request.conversationId,
            runId,
            role: "user",
            messageType: "compaction",
            content: compactionStoredContent(head.summary),
            createdAt: now().toISOString()
          });
        }
        return transformed;
      };

      const maxTurns = dependencies.maxTurns ?? DEFAULT_MAX_TURNS;
      // report 工具按 run 装配：sink 转接 publish 落 run_events（事件名 workflow_node / pdf_export 不变）。
      const reportTool = dependencies.reportToolFactory?.({
        recordEvent: async (type, payload) => {
          await publish(userId, snapshot, type, payload);
        },
        userId,
        conversationId: request.conversationId,
        runId
      });
      const tools = reportTool ? [...dependencies.tools, reportTool] : dependencies.tools;
      // metadata.hint 只做 system prompt 约束（不落库：messages/runs 无 metadata 列，避免动 schema）。
      const systemPrompt = request.metadata?.hint === "report"
        ? `${BASE_SYSTEM_PROMPT}\n${REPORT_HINT_SYSTEM_INSTRUCTION}`
        : BASE_SYSTEM_PROMPT;
      const stream = agentLoop(
        [prompt],
        { systemPrompt, messages: history, tools },
        {
          model: runtime.model,
          apiKey: runtime.apiKey,
          convertToLlm: defaultConvertToLlm,
          transformContext,
          shouldStopAfterTurn: ({ newMessages }) =>
            newMessages.filter((message) => message.role === "assistant").length >= maxTurns
        },
        controller.signal,
        runtime.streamFn as StreamFn | undefined
      );

      // 顺序消费事件流：逐事件落库（先落库后广播由 publish 保证），message_end 落终态消息。
      let terminalMessages: AgentMessage[] = [];
      let lastUserMessageTimestamp: number | undefined;
      // 在线成本汇总（P3 成本归因）：在事件循环内累加，agent_end 时落一条 cost_summary 能力事件。
      const costByModel = new Map<string, { input: number; output: number; totalTokens: number; cost: number }>();
      const costByTool = new Map<string, { input: number; output: number; totalTokens: number; cost: number }>();
      let totalTokens = 0;
      let totalCost = 0;
      for await (const event of stream) {
        await publish(userId, snapshot, event.type, event);
        // 成本累加：message_end 仅 assistant 消息带 usage；tool_execution_end 可选携带 result.usage / details.usage。
        // 全部数值防御式读取（缺失/非有限 → 0），缺失 usage 的 tool 事件直接跳过，绝不抛异常。
        if (event.type === "message_end" && event.message.role === "assistant") {
          const usage = event.message.usage;
          const input = Number.isFinite(usage.input) ? usage.input : 0;
          const output = Number.isFinite(usage.output) ? usage.output : 0;
          const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
          const cost = Number.isFinite(usage.cost?.total) ? (usage.cost?.total ?? 0) : 0;
          const key = event.message.model;
          const entry = costByModel.get(key) ?? { input: 0, output: 0, totalTokens: 0, cost: 0 };
          entry.input += input;
          entry.output += output;
          entry.totalTokens += total;
          entry.cost += cost;
          costByModel.set(key, entry);
          totalTokens += total;
          totalCost += cost;
        }
        if (event.type === "tool_execution_end") {
          const result = event.result as
            | { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }; details?: { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } } }
            | undefined;
          const usage = result?.usage ?? result?.details?.usage;
          if (usage) {
            const input = Number.isFinite(usage.input ?? 0) ? (usage.input ?? 0) : 0;
            const output = Number.isFinite(usage.output ?? 0) ? (usage.output ?? 0) : 0;
            const total = Number.isFinite(usage.totalTokens ?? 0) ? (usage.totalTokens ?? 0) : 0;
            const cost = Number.isFinite(usage.cost?.total ?? 0) ? (usage.cost?.total ?? 0) : 0;
            const key = event.toolName;
            const entry = costByTool.get(key) ?? { input: 0, output: 0, totalTokens: 0, cost: 0 };
            entry.input += input;
            entry.output += output;
            entry.totalTokens += total;
            entry.cost += cost;
            costByTool.set(key, entry);
            totalTokens += total;
            totalCost += cost;
          }
        }
        if (event.type === "message_end") {
          if (!promptMarked && event.message.role === "user") {
            promptMarked = true;
            persistedMessages.add(event.message);
            lastUserMessageTimestamp = event.message.timestamp;
          } else {
            const stored = await persistMessage(event.message);
            if (event.message.role === "user") {
              lastUserMessageTimestamp = event.message.timestamp;
            } else if (stored && event.message.role === "assistant" && lastUserMessageTimestamp !== undefined && isFinalAssistantMessage(event.message)) {
              const turnCitations = grounding?.getCitationsForTurn(lastUserMessageTimestamp) ?? [];
              if (turnCitations.length > 0) {
                await dependencies.citationRepository.saveMessageCitations(userId, stored.id, toNewCitationInputs(turnCitations));
              }
            }
          }
        }
        if (event.type === "agent_end") {
          terminalMessages = event.messages;
          // 落在线成本汇总事件（cost_summary）：对齐 trace 的 CostSummaryEvent payload 形状。
          // 最佳努力：成本统计为观测性数据，落库失败不应让一次成功的 run 变为 failed。
          try {
            await publish(userId, snapshot, "cost_summary", {
              byModel: Object.fromEntries(costByModel),
              byTool: Object.fromEntries(costByTool),
              totalTokens,
              totalCost,
            });
          } catch {
            // 观测性事件落库失败时忽略，不影响 run 终态。
          }
        }
      }
      // 终态兜底：遗漏的消息一次性补落（保持 run 内顺序）。
      for (const message of terminalMessages) {
        const stored = await persistMessage(message);
        if (stored && message.role === "assistant" && lastUserMessageTimestamp !== undefined && isFinalAssistantMessage(message)) {
          const turnCitations = grounding?.getCitationsForTurn(lastUserMessageTimestamp) ?? [];
          if (turnCitations.length > 0) {
            await dependencies.citationRepository.saveMessageCitations(userId, stored.id, toNewCitationInputs(turnCitations));
          }
        }
      }
    } catch (caught) {
      await publish(userId, snapshot, "run_error", { error: toRunError(caught, snapshot.requestId, controller.signal.aborted) });
    } finally {
      dependencies.executionRegistry.delete(runId);
    }
  }

  return {
    async create(request, userId) {
      if (shuttingDown) throw new RunServiceShuttingDownError();
      const modelId = request.modelId ?? dependencies.defaultModelId ?? "mock";
      if (dependencies.hasModel && !dependencies.hasModel(modelId)) {
        throw new RunModelNotFoundError(modelId);
      }
      if (request.attachmentDocumentIds && request.attachmentDocumentIds.length > 0) {
        for (const documentId of request.attachmentDocumentIds) {
          const upload = await dependencies.attachmentRepository.findByDocumentId(userId, documentId);
          if (!upload || upload.status !== "indexed") {
            throw new RunAttachmentNotFoundError(documentId);
          }
        }
      }
      const runId = createId("run");
      // 浏览器幂等键按用户命名空间化，既满足全局唯一约束，也不会产生跨用户冲突侧信道。
      const requestId = request.clientMessageId
        ? `req_${createHash("sha256").update(`${userId}\0${request.clientMessageId}`).digest("hex")}`
        : createId("api_req");
      const created = await dependencies.store.create({
        runId,
        requestId,
        userId,
        conversationId: request.conversationId,
        message: request.message.trim(),
        clientMessageId: request.clientMessageId ?? requestId,
        mode: request.mode,
        source: request.source,
        modelId,
        createdAt: now().toISOString()
      });
      const actual = created.snapshot;
      if (!created.created) {
        return {
          runId: actual.runId,
          requestId: actual.requestId,
          conversationId: actual.conversationId,
          modelId: actual.modelId,
          status: "queued",
          eventsUrl: `/api/runs/${actual.runId}/events`,
          snapshotUrl: `/api/runs/${actual.runId}`
        };
      }
      dependencies.executionRegistry.create(runId);
      await publish(userId, actual, "run_status", { status: "queued", message: "研究任务已进入队列。" });
      dependencies.scheduler.schedule(() =>
        enqueueConversationRun(`${userId}:${request.conversationId}`, () => execute(runId, request, userId))
      );
      return {
        runId,
        requestId,
        conversationId: request.conversationId,
        modelId,
        status: "queued",
        eventsUrl: `/api/runs/${runId}/events`,
        snapshotUrl: `/api/runs/${runId}`
      };
    },
    get: (userId, runId) => dependencies.store.findById(userId, runId),
    async cancel(userId, runId) {
      const snapshot = await dependencies.store.findById(userId, runId);
      if (!snapshot) return undefined;
      if (snapshot.status === "queued" || snapshot.status === "running") {
        // abort 后 loop 以 stopReason='aborted' 收尾，agent_end 落库时由 store 推导 cancelled。
        dependencies.executionRegistry.get(runId)?.abort();
      }
      return dependencies.store.findById(userId, runId);
    },
    listEvents: (userId, runId, afterSequence) => dependencies.store.listEvents(userId, runId, afterSequence),
    subscribe: (runId, listener) => dependencies.eventBus.subscribe(runId, listener),
    recoverStale,
    isShuttingDown: () => shuttingDown,
    async shutdown({ drainMs }) {
      shuttingDown = true;
      // 先中断在途执行，执行体观察到 abort 后自行走取消收尾并退出 registry。
      for (const runId of dependencies.executionRegistry.list()) {
        dependencies.executionRegistry.get(runId)?.abort();
      }
      const deadline = Date.now() + drainMs;
      while (dependencies.executionRegistry.list().length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // drain 窗口内仍未终态的 Run 统一落库为可解释的 interrupted，与重启恢复语义一致。
      const interrupted = await recoverStale(now().toISOString());
      return { interrupted };
    }
  };
}

/**
 * 默认确定性摘要器（无 LLM 调用）：拼接被裁消息的文本并截断。
 * 学习阶段的简化实现；生产可替换为基于 streamSimple 的 LLM 摘要。
 *
 * @param messages 被裁前缀消息。
 * @param previousSummary 上一次压缩的摘要（迭代更新场景）。
 * @returns 摘要文本。
 */
async function defaultSummarizer(messages: AgentMessage[], previousSummary: string | undefined): Promise<string> {
  const text = messages
    .map((message) => {
      if (message.role === "compaction") return message.summary;
      const content = message.content;
      if (typeof content === "string") return content;
      return content
        .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
        .join(" ");
    })
    .join("\n")
    .slice(0, 800);
  return `${previousSummary ? `${previousSummary}\n` : ""}（自动摘要）${text}`;
}

/**
 * 判断 assistant 消息是否为该 turn 的最终回答（不含 toolCall 块）。
 * 工具调用轮的中间 assistant 消息只携带 toolCalls，不应挂载 citation。
 *
 * @param message agent loop 输出的消息。
 * @returns 是最终回答时返回 true。
 */
function isFinalAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  const content = message.content;
  if (typeof content === "string") return true;
  return !content.some((block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall");
}

/**
 * 把 grounding 检索到的 citation 映射为落库输入。
 * claim 暂用 quote 快照；后续可扩展为模型回答中的具体主张。
 *
 * @param citations grounding 注入的 citation 列表。
 * @returns citation 落库输入。
 */
function toNewCitationInputs(citations: Citation[]): NewCitationInput[] {
  return citations.map((citation, index) => ({
    ordinal: index + 1,
    chunkId: citation.chunkId,
    claim: citation.quote,
    quote: citation.quote,
    score: citation.confidence,
    verifierStatus: "unverified" as const
  }));
}

/**
 * 把执行层异常收敛为结构化 run 错误，不泄漏原始异常细节。
 *
 * @param caught 原始异常。
 * @param requestId 请求标识。
 * @param cancelled 是否为用户取消。
 * @returns 脱敏后的 ApiError。
 */
function toRunError(caught: unknown, requestId: string, cancelled: boolean): ApiError {
  void caught;
  return {
    code: cancelled ? "request_cancelled" : "internal_error",
    message: cancelled ? "Agent run 已取消。" : "Agent 服务暂时不可用，请稍后重试。",
    requestId
  };
}

/** shutdown 期间拒绝新 Run 的结构化错误；API 层映射为 503，不泄漏内部状态。 */
export class RunServiceShuttingDownError extends Error {
  constructor() {
    super("Run service is shutting down.");
    this.name = "RunServiceShuttingDownError";
  }
}

/** 请求引用了服务端目录之外的模型；route 将其映射为稳定 validation_failed。 */
export class RunModelNotFoundError extends Error {
  /** @param modelId 非法或不可用模型 ID。 */
  constructor(readonly modelId: string) {
    super(`Model is not available: ${modelId}`);
    this.name = "RunModelNotFoundError";
  }
}

/** 请求引用了不存在、未 indexing 或不属于当前用户的附件；route 映射为 validation_failed。 */
export class RunAttachmentNotFoundError extends Error {
  /** @param documentId 非法或不可用的附件 documentId。 */
  constructor(readonly documentId: string) {
    super(`Attachment is not available: ${documentId}`);
    this.name = "RunAttachmentNotFoundError";
  }
}

/** 保持对 AgentEvent 类型的显式引用，文档化事件协议来源。 */
export type { AgentEvent };
