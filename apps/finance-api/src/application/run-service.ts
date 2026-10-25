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
import { agentLoop, createCompactionTransform, defaultConvertToLlm, projectContextBudgetSummary } from "@aiagent/agent";
import type { AgentEvent, AgentMessage, AgentTool, ContextBudgetReport, StreamFn } from "@aiagent/agent";
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
  createMultiSourceRetriever,
  type AttachmentStore,
  type Citation,
  type CitationRepository,
  type DataSourceRuntime,
  type DataSourceRuntimeResult,
  type EmbeddingClient,
  type InlineAttachment,
  type NewCitationInput,
  type RetrievalLeg,
  type Retriever
} from "@aiagent/rag";
import { redactSensitiveValue } from "@aiagent/trace";
import type { ToolResultStore } from "@aiagent/database";
import { createHash, randomUUID } from "node:crypto";
import { createInMemoryRunCancelStore, createInMemoryToolResultStore } from "../adapters/in-memory-run-runtime.js";
import { createCircuitBreaker, guardStreamFn, type CircuitBreaker } from "./circuit-breaker.js";
import { createInMemoryBudgetTracker, type BudgetConfig, type BudgetTracker } from "./budget-tracker.js";
import type { AgentToolResult } from "@aiagent/tools";
import type { RunCancelStore, RunEventBus, RunExecutionRegistry, RunStore } from "./run-ports.js";
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

/**
 * 可选上下文装配 transform（context-assembly）的契约：仅当集成方显式装配时才提供。
 * run-service 不自行创建它（保持「不强行接入 context-assembly」的受控边界，避免改变现有 app 行为）。
 * 第三个参数 `recordBudgetMetric` 由 run-service 透传，供装配器回写 ContextBudgetReport；
 * 不传（未提供 budgetMetricSink 时）则装配器不 emit 预算指标。
 */
export type ContextAssemblyTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
  recordBudgetMetric?: (report: unknown) => void,
) => Promise<AgentMessage[]>;

export interface RunServiceDependencies {
  store: RunStore;
  messageStore: MessageStore;
  eventBus: RunEventBus;
  executionRegistry: RunExecutionRegistry;
  /** 按目录模型 ID 解析可执行模型 runtime。 */
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
  /**
   * 内部知识库 runtime；P2 起作为多路召回的"内部库 leg"注入 grounding。
   * 缺失时只走附件路（附件索引 leg + 内联附件），不影响 run 本身。
   */
  dataSourceRuntime?: DataSourceRuntimeWithRetriever;
  /** Citation repository，用于把 grounding 检索结果持久化到 assistant message。 */
  citationRepository: CitationRepository;
  /** 单 run 最大 turn 数预算。 */
  maxTurns?: number;
  compaction?: RunCompactionOptions;
  /**
   * 可选上下文装配 transform（context-assembly）：仅当集成方显式装配时才提供。
   * run-service 不自行创建它（保持「不强行接入 context-assembly」的受控边界，避免改变现有 app 行为）。
   * 提供时，run-service 在 transformContext 内用它替换 compaction 前的装配步，并把 budgetMetricSink
   * 透传为它的 recordBudgetMetric；缺省时 run 行为与现在完全一致。
   */
  contextAssemblyTransform?: ContextAssemblyTransform;
  /**
   * 可选上下文预算指标 sink：仅当集成方装配了 context-assembly（contextAssemblyTransform）时才有意义。
   * run-service 收集每次 transform 产出的 ContextBudgetReport 并在 agent_end 投影进 cost_summary.contextBudget。
   * 当前 app 默认未装配，故该 sink 不被调用、数组为空、contextBudget 段省略——有意的分层，非缺陷。
   */
  budgetMetricSink?: (report: unknown) => void;
  now?: () => Date;
  createId?: (prefix: string) => string;
  /**
   * 跨实例取消标记存储（queued 竞态兜底）：execute 启动时回查已取消的 run，
   * 覆盖"取消广播早于订阅"的丢失窗口。缺省退化为进程内实现（单实例）。
   */
  cancelStore?: RunCancelStore;
  /**
   * 写类工具结果去重存储（at-least-once 重排的副作用安全网）。缺省退化为进程内实现。
   * 按 (run_id, tool_call_id) 幂等落工具结果，恢复续跑时据此跳过已完成的写类工具。
   */
  toolResultStore?: ToolResultStore;
  /**
   * 被视为"写类"（有副作用、需去重）的工具名称集合。命中的工具在续跑恢复时若已有结果则直接复用，
   * 不再重放副作用。缺省为空（不去重任何工具）——引入写类工具时由组合根显式声明。
   */
  writeToolNames?: string[];
  /**
   * 运行预算上限配置（成本 guardrail，env 驱动）。缺省不限制；组合根从 env 注入具体上限。
   * 仅当未显式注入 `budgetTracker` 时生效（作为其内部追踪器的上限来源）。
   */
  budget?: BudgetConfig;
  /** 运行预算追踪器（成本 guardrail）；缺省按 `budget` 配置创建进程内实现。 */
  budgetTracker?: BudgetTracker;
  /** LLM provider 熔断器（运行时 SLO 熔断）；缺省从 env 创建实例级熔断器。 */
  circuitBreaker?: CircuitBreaker;
}

export interface RunApplicationService {
  create(request: AgentRunCreateRequestDto, userId: string): Promise<AgentRunAcceptedDto>;
  /**
   * 执行一次 run（供 worker loop 调用）。从 request_payload 重建请求上下文，
   * 逐事件落库广播并补落消息；异常被收敛为 run_error 事件，不会向上抛。
   *
   * @param runId Run 标识。
   * @param request 重建的创建请求（来自 store.claimNext 的 request_payload）。
   * @param userId 当前用户。
   * @returns 执行完成 Promise（异常已内部消化）。
   */
  execute(runId: string, request: AgentRunCreateRequestDto, userId: string): Promise<void>;
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
  // 跨实例取消兜底：缺省进程内实现（单实例）。多实例部署由组合根注入 DB 实现。
  const cancelStore = dependencies.cancelStore ?? createInMemoryRunCancelStore();
  // 写类工具结果去重：缺省进程内实现（单实例）。多实例/持久化由组合根注入 DB 实现。
  const toolResultStore = dependencies.toolResultStore ?? createInMemoryToolResultStore();
  // 写类工具名集合：命中的工具在续跑时若已有结果直接复用，避免重复副作用。
  const writeToolNames = dependencies.writeToolNames ?? [];
  // 成本 guardrail：缺省按 budget 配置创建进程内预算追踪器（run 级 + 进程内 user 级）。
  const budgetTracker = dependencies.budgetTracker ?? createInMemoryBudgetTracker(dependencies.budget ?? {});
  // 运行时 SLO 熔断：缺省从 env 创建实例级 LLM provider 熔断器。
  const circuitBreaker = dependencies.circuitBreaker ?? createCircuitBreaker();
  // shutdown 期间拒绝新 Run，避免关闭窗口内写入无法 drain 的任务。
  let shuttingDown = false;

  async function recoverStale(before: string): Promise<number> {
    const events = await dependencies.store.recoverStale(before, now().toISOString());
    for (const event of events) dependencies.eventBus.publish(event);
    return events.length;
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
    // 确保本地 AbortController 存在：run 实际执行所在实例可能与收到 create 请求的实例不同
    // （worker claim 跨实例），因此 execute 兜底创建并订阅共享取消信号；同实例重复 create 幂等返回既有控制器。
    let controller = dependencies.executionRegistry.get(runId);
    if (!controller) controller = dependencies.executionRegistry.create(runId);
    // queued 竞态兜底：若取消广播早于本实例订阅（进程内 pub/sub 不回放），回查持久化取消标记，
    // 命中则立即中断，使已取消的 queued run 不会在 claim 后真正执行。
    if (await cancelStore.isCancelled(runId)) controller.abort();
    const snapshot = await dependencies.store.findById(userId, runId);
    if (!snapshot) return;
    // 终态推导标记：catch 内发过 run_error 时置位；声明在函数作用域，便于 catch 访问（try 内 let 不可见）。
    let emittedRunError = false;
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

      // grounding：P2 多路召回（附件索引路 + 内部库路）+ 内联附件。
      // 附件存储与 embedding provider 缺一不可：都就绪才构造附件 leg，否则跳过附件注入（run 本身不受影响）。
      // 内部库 leg 由 dataSourceRuntime.retriever({ ownerUserId }) 构造；失败时跳过该 leg，不影响附件路。
      // 仅当有检索腿或有内联附件时才构造 grounding；否则原样返回消息，不注入任何上下文。
      const topK = 5;
      const attachmentStore = dependencies.attachmentStore;
      const embeddingClient = dependencies.embeddingClient;

      // best-effort TTL 续期：会话附件可能在上传后过一段时间才被提问，续期避免过期。
      if (attachmentStore) {
        try {
          await attachmentStore.touch(request.conversationId);
        } catch {
          // 续期失败不阻断 run：附件可能已过期，后续检索返回空结果即可。
        }
      }

      // 构造多路召回 legs：附件索引路 + 内部库路。
      const legs: RetrievalLeg[] = [];
      if (attachmentStore && embeddingClient && request.attachmentDocumentIds && request.attachmentDocumentIds.length > 0) {
        legs.push({
          sourceKind: "attachment",
          retriever: createAttachmentRetriever({
            embeddingClient,
            attachmentStore,
            conversationId: request.conversationId,
            topK
          })
        });
      }
      if (dependencies.dataSourceRuntime) {
        const retrieverResult = await dependencies.dataSourceRuntime.retriever({ ownerUserId: userId });
        if (retrieverResult.ok) {
          legs.push({ sourceKind: "internal", retriever: retrieverResult.data });
        }
      }

      // 多路编排器：legs 为空时不创建（直接传 undefined 给 grounding）。
      const multiSourceRetriever = legs.length > 0
        ? createMultiSourceRetriever({ legs, topK })
        : undefined;

      // 解析内联附件：按 attachmentDocumentIds 从附件存储读取内联原文槽。
      // 小附件走内联（不建向量索引），大附件走向量检索；两者可以共存（不同 documentId）。
      const inlineAttachments: InlineAttachment[] = [];
      if (attachmentStore && request.attachmentDocumentIds) {
        for (const documentId of request.attachmentDocumentIds) {
          const inline = await attachmentStore.getInline(request.conversationId, documentId);
          if (inline) inlineAttachments.push(inline);
        }
      }

      // grounding 门禁：既无检索腿又无内联附件时不注入。
      const grounding = (multiSourceRetriever || inlineAttachments.length > 0)
        ? createGroundingTransformContext({
            retriever: multiSourceRetriever,
            inlineAttachments,
            conversationId: request.conversationId,
            topK,
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
      // 上下文装配步：优先用集成方提供的 context-assembly transform（会经 recordBudgetMetric 回写预算指标）；
      // 缺省则走既有 compactionTransform。是否装配 context-assembly 由调用方决定，run-service 不改此行为。
      const contextAssemblyTransform = dependencies.contextAssemblyTransform;
      const transformContext = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
        const grounded = grounding ? await grounding(messages, signal) : messages;
        const transformed = contextAssemblyTransform
          ? await contextAssemblyTransform(grounded, signal, recordBudgetMetric)
          : await compactionTransform(grounded, signal);
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
      // 成本 guardrail：预算超限标记（run 级 + user 级）。超限后本轮边界停止 run。
      // 声明提升到 shouldStopAfterTurn 之前，便于在轮边界回调与 message_end 增量校验间共享（可读性）。
      let budgetExceeded = false;
      let budgetExceededReason: string | undefined;
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
      // 写类工具去重包裹：命中的写类工具在续跑恢复时若已有 (run_id, tool_call_id) 结果，
      // 直接复用而不重放副作用（at-least-once 重排的副作用安全网）。读类/只读工具不去重。
      const dedupTools = tools.map((tool) => wrapWriteToolWithDedup(tool, runId, toolResultStore, writeToolNames));
      // metadata.hint 只做 system prompt 约束（不落库：messages/runs 无 metadata 列，避免动 schema）。
      const systemPrompt = request.metadata?.hint === "report"
        ? `${BASE_SYSTEM_PROMPT}\n${REPORT_HINT_SYSTEM_INSTRUCTION}`
        : BASE_SYSTEM_PROMPT;
      // 续跑恢复：若快照已带检查点（turn>0），说明此前至少已完成若干轮并已落库，
      // 则从最近检查点续跑——用已落库消息（listForContext 投影，含 prompt + 已完成轮次的 assistant/toolResult）
      // 重建上下文，跳过已完成轮次，不再仅从 request_payload 重放全部轮次（docs/v1.2 §4 P1）。
      // 完成轮数作为预算/计数基线，避免续跑把"历史轮数"重复计入 maxTurns/assistantTurns。
      const completedTurns = snapshot.lastCheckpoint?.turn ?? 0;
      const resume = completedTurns > 0;
      // 续跑不追加 prompt：重建后的 history 已含 create 时落库的用户消息，避免重复落一条 user。
      const initialPrompts: AgentMessage[] = resume ? [] : [prompt];
      const stream = agentLoop(
        initialPrompts,
        { systemPrompt, messages: history, tools: dedupTools },
        {
          model: runtime.model,
          apiKey: runtime.apiKey,
          convertToLlm: defaultConvertToLlm,
          transformContext,
          shouldStopAfterTurn: ({ newMessages }) =>
            // 总完成轮数 = 已完成（检查点） + 本次续跑新产出的 assistant；续跑时从 completedTurns 续计，避免重复耗尽预算。
            completedTurns + newMessages.filter((message) => message.role === "assistant").length >= maxTurns
            // 成本 guardrail：预算超限后在本轮边界停止，避免失控 run 继续烧 token/成本。
            || budgetExceeded
        },
        controller.signal,
        // 运行时 SLO 熔断：用熔断器包装 streamFn，provider 连续故障时快速失败而非反复重试放大故障。
        circuitBreaker ? (guardStreamFn(runtime.streamFn, circuitBreaker) as unknown as StreamFn) : (runtime.streamFn as StreamFn)
      );

      // 顺序消费事件流：逐事件落库（先落库后广播由 publish 保证），message_end 落终态消息。
      let terminalMessages: AgentMessage[] = [];
      let lastUserMessageTimestamp: number | undefined;
      // 在线成本汇总（P3 成本归因）：在事件循环内累加，agent_end 时落一条 cost_summary 能力事件。
      const costByModel = new Map<string, { input: number; output: number; totalTokens: number; cost: number }>();
      const costByTool = new Map<string, { input: number; output: number; totalTokens: number; cost: number }>();
      let totalTokens = 0;
      let totalCost = 0;
      // SLO / 容量证据（docs/v1.2 §3 差距#7 收口）：成本已由上方累加覆盖，这里补时延/成功率/并发。
      // 全部防御式采集，仅当取到有限有效值才并入 cost_summary.payload（绝不干扰既有事件）。
      const runStartedAt = now().getTime();
      // turn 数 = 本次 run 产生的 assistant 消息数（与成本累加共用同一 message_end 分支）。
      // 续跑时从检查点的已完成轮数续计，使 totalTurns 反映整次运行（含崩溃前已完成轮次），
      // 检查点写入 (turn: assistantTurns) 与 maxTurns 预算都据此单调累计。
      let assistantTurns = completedTurns;
      // 运行期间观测到的活跃 run 峰值：事件循环内周期采样 executionRegistry 计数；初值取起点快照。
      let peakConcurrency = dependencies.executionRegistry.list().length;
      // 团队成本**不在本文件累加**（G-T1 单一路径，docs/v2.0/03-team-eval.md §9.1）：
      // `cost_summary.payload.team` 只能由「创建 TeamController 并托管 run 的那条产线」经
      // `@aiagent/agent` 的 `projectTeamCostSummary` 投影产出（当前落点是 packages/serve 的
      // `run/manager` 收尾）。finance-api 不创建 TeamController，也没有 TeamState，任何在本文件
      // 手工累加 SendMessage 结果的做法都会形成「字段口径不同的第二份真相源」（缺 durationMs /
      // 缺 0 用量成员），故这里只做防御性告警，绝不组装 team 段。
      // 受控上下文预算收集（P3 可观测）：仅当集成方提供 budgetMetricSink 时才填充；
      // 当前 app 默认未装配 context-assembly，故数组恒为空、contextBudget 段省略。
      const contextBudgetReports: ContextBudgetReport[] = [];
      // 第二口径告警去重标记（每 run 只告警一次，见 SendMessage 分支）。
      let teamCostWarned = false;
      // 预算指标 sink：转发给调用方并本地收集；未提供 budgetMetricSink 时为 undefined（装配器不 emit）。
      const recordBudgetMetric = dependencies.budgetMetricSink
        ? (report: unknown): void => {
            // 防御式：仅收集对象型 report，过滤非预期值；成本统计为观测数据，绝不抛异常。
            if (report && typeof report === "object" && !Array.isArray(report)) {
              contextBudgetReports.push(report as ContextBudgetReport);
            }
            dependencies.budgetMetricSink?.(report);
          }
        : undefined;
      // 已落库事件高水位：用于检查点记录"从哪条事件续跑"。
      let latestSequence = snapshot.lastEventSequence;
      for await (const event of stream) {
        const published = await publish(userId, snapshot, event.type, event);
        if (published?.sequence !== undefined) latestSequence = published.sequence;
        // 容量采样：每次落库后刷新观测到的活跃 run 峰值（executionRegistry.list().length 为接口现有方法）。
        const activeNow = dependencies.executionRegistry.list().length;
        if (activeNow > peakConcurrency) peakConcurrency = activeNow;
        // 成本累加：message_end 仅 assistant 消息带 usage；tool_execution_end 可选携带 result.usage / details.usage。
        // 全部数值防御式读取（缺失/非有限 → 0），缺失 usage 的 tool 事件直接跳过，绝不抛异常。
        if (event.type === "message_end" && event.message.role === "assistant") {
          assistantTurns++;
          // 每轮（assistant 终态消息）提交后写执行检查点：记录 (turn, 事件高水位)，
          // 支持恢复时从最近检查点续跑而非整 Run 重排（P1 收敛 at-least-once 副作用安全）。
          // 最佳努力：检查点仅为恢复优化，写入失败不阻断 run 终态。
          try {
            await dependencies.store.setCheckpoint(userId, runId, {
              turn: assistantTurns,
              lastEventSequence: latestSequence,
              createdAt: now().toISOString()
            });
          } catch {
            // 检查点写入失败忽略，不影响 run 本身。
          }
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
          // 成本 guardrail：增量后立即做预算校验（run 级 + user 级）；超限则标记，本轮边界停止。
          // budgetTracker.record 防御式：异常不应中断 run，仅当超时时置位标记。
          try {
            const check = budgetTracker.record(userId, runId, total, cost);
            if (check.overBudget) {
              budgetExceeded = true;
              budgetExceededReason = check.reason;
            }
          } catch {
            // 预算校验异常忽略，不影响 run 本身。
          }
        }
        if (event.type === "tool_execution_end") {
          // 写类工具结果去重由 wrapWriteToolWithDedup 以"工具名 + 参数哈希"确定性键落库（P1 修订），
          // 此处不再以模型生成的 toolCall.id 重复记录——否则重排时该键查不到，反而重复副作用。
          // 仅对读类/非写类工具保留原有 (run_id, tool_call_id) 记录（无害，仅作观测/续跑投影）。
          if (!writeToolNames.includes(event.toolName)) {
            try {
              await toolResultStore.record({
                runId,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result
              });
            } catch {
              // 去重落库失败忽略，不影响 run 本身。
            }
          }
          // 受控团队成本（G-T1）：**明确禁用第二口径**。若未来 finance-api 真的装配了 team 工具，
          // 这里会显式告警而不是静默产出半成品 team 段——team 成本只能由 serve 经
          // `projectTeamCostSummary` 投影，字段口径（durationMs / 0 用量成员 / peakConcurrency）
          // 必须唯一。告警按 run 只打一次，避免 SendMessage 多次派发刷屏。
          if (event.toolName === "SendMessage") {
            if (!teamCostWarned) {
              teamCostWarned = true;
              process.emitWarning(
                "finance-api 观测到 SendMessage 子代理调用，但 team 成本只由 serve 的 projectTeamCostSummary 投影；本次 run 的 cost_summary 不含 team 段。",
                { code: "OHNA_TEAM_COST_SECOND_SOURCE_DISABLED" }
              );
            }
            // SendMessage 的子代理成本经 team 段单独归因，不进入 byTool（避免产生误导性的 0 行）。
          } else {
            // 既有 byTool 累加逻辑（原样保留，仅作用于非 team 工具）。
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
            // 既有 byModel/byTool/totalTokens/totalCost 段（原样保留，作为跨边界 DTO 直接序列化）。
            const costSummaryPayload: Record<string, unknown> = {
              byModel: Object.fromEntries(costByModel),
              byTool: Object.fromEntries(costByTool),
              totalTokens,
              totalCost,
            };
            // 不写 `team` 段（G-T1）：该段唯一真相源是 serve 经 `projectTeamCostSummary` 的投影，
            // finance-api 没有 TeamState，任何本地组装都会与 serve 口径分叉。见上方 SendMessage 分支告警。
            // 受控上下文预算段：仅当 budgetMetricSink 收集到 report 才并入（当前 app 默认未装配）。
            if (contextBudgetReports.length > 0) {
              costSummaryPayload.contextBudget = projectContextBudgetSummary(contextBudgetReports);
            }
            // SLO / 容量证据段（docs/v1.2 §3 差距#7 收口）：增量、受控并入，绝不改变既有 cost_summary 形状。
            // 仅当取到有限有效值才写字段——脏样本（缺失/NaN）跳过，避免污染既有事件或落库失败。
            const durationMs = Number.isFinite(runStartedAt) ? now().getTime() - runStartedAt : undefined;
            if (durationMs !== undefined && durationMs >= 0) costSummaryPayload.durationMs = durationMs;
            // turn 数：至少 1 条 assistant 消息才视为有效统计（常规 run 必有 ≥1 条）。
            if (assistantTurns > 0) costSummaryPayload.turnCount = assistantTurns;
            // 终态推导：发过 run_error → failed；取消信号置位 → interrupted；其余 completed（防御式默认）。
            const outcome: "completed" | "failed" | "interrupted" = emittedRunError
              ? "failed"
              : controller.signal.aborted
                ? "interrupted"
                : "completed";
            costSummaryPayload.outcome = outcome;
            // 成本 guardrail：预算超限标记（run 级 + user 级）。超限后 run 在轮边界停止，
            // 终态仍为 completed（非取消/失败），但透出 budgetExceeded 供成本归因与告警。
            if (budgetExceeded) {
              costSummaryPayload.budgetExceeded = true;
              if (budgetExceededReason) costSummaryPayload.budgetExceededReason = budgetExceededReason;
            }
            // 容量快照：结束时活跃 run 数（取自 executionRegistry，接口合规用 list().length）。
            const activeRuns = dependencies.executionRegistry.list().length;
            if (Number.isFinite(activeRuns)) costSummaryPayload.activeRuns = activeRuns;
            // 容量峰值：运行期间观测到的活跃 run 峰值（采样值，受控、不额外依赖）。
            if (Number.isFinite(peakConcurrency)) costSummaryPayload.peakConcurrency = peakConcurrency;
            await publish(userId, snapshot, "cost_summary", costSummaryPayload);
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
      // 标记本次 run 发过 run_error，供 agent_end（若可达）推导 outcome=failed；落库失败被既有 try/catch 兜住。
      emittedRunError = true;
      await publish(userId, snapshot, "run_error", { error: toRunError(caught, snapshot.requestId, controller.signal.aborted) });
    } finally {
      dependencies.executionRegistry.delete(runId);
    }
  }

  return {
    async create(request, userId) {
      if (shuttingDown) throw new RunServiceShuttingDownError();
      const modelId = request.modelId ?? dependencies.defaultModelId;
      if (!modelId) {
        throw new RunModelNotFoundError("");
      }
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
        createdAt: now().toISOString(),
        requestPayload: request
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
      // 不再同步执行：store.create 已落 status='queued'，run-worker 的 claimNext 会轮询抢占该 run 并异步执行。
      // 入队与执行解耦后，HTTP 响应立即返回，崩溃也不丢 run（recoverStale 重置过期 lease 重排）。
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
    execute,
    get: (userId, runId) => dependencies.store.findById(userId, runId),
    async cancel(userId, runId) {
      const snapshot = await dependencies.store.findById(userId, runId);
      if (!snapshot) return undefined;
      if (snapshot.status === "queued" || snapshot.status === "running") {
        // 跨实例取消：写持久化标记（queued 兜底）+ 广播即时信号（在途中断）。
        // 取代原进程内 get(runId)?.abort()——后者只能中断创建控制器所在进程内的 run。
        await dependencies.executionRegistry.requestCancel(runId);
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
      // requestCancel 跨实例广播：本实例在途 run 经本地订阅即时中断；其他实例同。
      for (const runId of dependencies.executionRegistry.list()) {
        await dependencies.executionRegistry.requestCancel(runId);
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
 * 稳定序列化：递归按 key 排序对象字段，使同一语义的参数在不同 key 插入顺序下得到一致字符串，
 * 避免 JSON.stringify 对 key 顺序敏感导致同一工具调用的去重哈希漂移。
 *
 * @param value 任意可 JSON 化的值。
 * @returns 规范化后的 JSON 字符串。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

/**
 * 派生写类工具去重键：以 (工具名 + 规范化参数哈希) 生成稳定键，替代模型生成的 toolCall.id。
 *
 * at-least-once 重排时模型会重新生成非可复现的 toolCall.id；若以该 id 去重，则重跑时查找必 miss、
 * 写类工具被再次执行 → 重复副作用（违反本项目正确性红线）。而同一工具 + 同一参数在重排中必然一致，
 * 故以确定性哈希为键，可使重跑复用已落库的 tool_results 行而非重放副作用。
 *
 * @param toolName 工具名。
 * @param args 工具参数（原始对象，key 顺序未必稳定）。
 * @returns 稳定去重键（sha256 十六进制）。
 */
function deriveWriteToolDedupKey(toolName: string, args: unknown): string {
  return createHash("sha256").update(`${toolName}\0${stableStringify(args)}`).digest("hex");
}

/**
 * 写类工具去重包裹：命中 `writeToolNames` 的工具在续跑恢复时若已有同一「工具名 + 规范化参数」的结果，
 * 直接复用而不重放副作用，使 at-least-once 重排只补未完成的轮次、绝不重复副作用。
 *
 * 实现要点：
 * - 去重键由 `deriveWriteToolDedupKey`（工具名 + 参数哈希）决定，与模型生成的 toolCall.id 无关，
 *   因此重排时即便 toolCall.id 重新生成，依旧命中已落库结果（修正原实现以 toolCall.id 去重必 miss 的缺陷）。
 * - 包裹后的 `execute` 在真正执行前先查去重存储；命中则原样返回已落结果（不重放副作用）。
 * - 首次执行成功后以确定性键落库（幂等：on conflict do nothing），供后续重排复用。
 * 缺省工具名集合为空，即不去重任何工具——引入写类工具时由组合根显式声明。
 *
 * @param tool 被包裹的原始工具。
 * @param runId 当前 run 标识（去重键的一部分）。
 * @param store 写类工具结果去重存储。
 * @param writeToolNames 写类工具名集合。
 * @returns 去重包裹后的工具（非写类工具原样返回）。
 */
export function wrapWriteToolWithDedup(
  tool: import("@aiagent/tools").AgentTool,
  runId: string,
  store: ToolResultStore,
  writeToolNames: string[]
): import("@aiagent/tools").AgentTool {
  if (!writeToolNames.includes(tool.name)) return tool;
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult> {
      // 续跑恢复：同一「工具名 + 规范化参数」已完成则复用结果，不重放副作用。
      // 键与模型生成的 toolCall.id 无关，故 at-least-once 重排（id 重新生成）仍能命中。
      const dedupKey = deriveWriteToolDedupKey(tool.name, params);
      const cached = await store.get(runId, dedupKey);
      if (cached) return cached.result as AgentToolResult;
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      // 以确定性键落库（幂等：on conflict do nothing），使后续重排复用而非重放副作用。
      // 最佳努力：去重存储写入失败不阻断 run 终态（仅为恢复优化）。
      try {
        await store.record({ runId, toolCallId: dedupKey, toolName: tool.name, result });
      } catch {
        // 去重落库失败忽略，不影响 run 本身。
      }
      return result;
    }
  };
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

/**
 * DataSourceRuntime 的 P2 扩展形态：retriever 方法已在 DataSourceRuntimeService 实现类上公开，
 * 但接口类型（types.ts）尚未同步声明。这里用结构化类型补充签名，使 run-service 可在编译期调用，
 * 无需修改 @aiagent/rag 包。当 rag 包接口补上 retriever 后此类型可直接删除。
 */
interface DataSourceRuntimeWithRetriever extends DataSourceRuntime {
  /**
   * 构造绑定当前 owner 的内部库检索器（多路召回的 internal leg）。
   *
   * @param context 调用身份；ownerUserId 缺省匿名。
   * @returns 成功时返回 Retriever，失败时返回结构化错误。
   */
  retriever(context?: { ownerUserId?: string }): Promise<DataSourceRuntimeResult<Retriever>>;
}
