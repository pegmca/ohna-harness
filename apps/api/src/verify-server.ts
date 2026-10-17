/**
 * 容量 / 故障演练基线验证服务器（离线、无 Postgres/Redis 依赖）。
 *
 * 本文件是「验证专用」composition root，仅供 test/verify-capacity-baseline.mjs 拉起测量实例，
 * 不属于生产链路。它与生产 server.ts 的区别：
 *   1. 使用 createInMemoryApiTestRuntime（内存事实源），无需 DATABASE_URL / REDIS_URL；
 *   2. 通过 env 把「测试替身 streamFn」包裹为可注入故障的版本，用于演练 LLM provider 熔断；
 *   3. 把熔断实例用可观测外壳包一层，在状态跃迁时记录服务器时钟时间戳，并通过 env 限定的
 *      /api/__verify/* 诊断端点对外暴露，使脚本能精确测量 trip / half-open / recovery 时刻。
 *
 * 仅当 AIAGENT_VERIFY_MODE=1 时才注册诊断端点；其余接口与真实 API 完全一致（run / SSE / identity）。
 */
import { createApiServer } from "./index.js";
import { createInMemoryApiTestRuntime } from "./adapters/in-memory-test-runtime.js";
import { createCircuitBreaker, type CircuitBreaker } from "./application/circuit-breaker.js";
import { createDefaultToolRegistry } from "@aiagent/tools";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@aiagent/ai";
import type { StreamFn } from "@aiagent/agent";

/** 读取可选正整数 env；缺失 / 非法 / ≤0 时返回 undefined。 */
function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 测试替身失败时回传的零用量统计，避免产生计费信号。 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
} as const;

/** 故障注入总开关：由 env 初始化，运行时经 /api/__verify/fail-inject 动态切换。 */
let failInjectEnabled = process.env.AIAGENT_VERIFY_LLM_FAIL === "1";

/**
 * 构造一个「在迭代期抛错」的失败事件流，模拟 LLM provider 在首事件前崩溃。
 * 迭代期抛错会被熔断器的 guardStream 捕获并记一次失败；同时异常向上穿透到 run-service.execute
 * 的 catch，使该 run 以 run_error（failed）收尾——既触发熔断，又真实反映 provider 故障后果。
 *
 * @returns 抛出异常的 AssistantMessageEventStream（契约上仍带 result()，仅供防御）。
 */
function createFailingStream(): AssistantMessageEventStream {
  async function* gen(): AsyncGenerator<never> {
    throw new Error("injected provider failure (capacity baseline harness)");
  }
  const stream = gen() as unknown as AssistantMessageEventStream;
  // 防御性：agentLoop 在迭代期抛错不会调用 result()，但保留以满足 StreamFn 契约形状。
  (stream as { result?: () => Promise<AssistantMessage> }).result = async () => ({
    role: "assistant",
    content: [{ type: "text", text: "injected failure" }],
    api: "openai-completions",
    provider: "test-double",
    model: "test-double",
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: "injected provider failure (capacity baseline harness)",
    timestamp: Date.now()
  } as AssistantMessage);
  return stream;
}

/**
 * 把基础测试替身 streamFn 包裹为可注入故障的版本：开关打开时返回失败流，否则原样委托。
 *
 * @param base 原始测试替身 streamFn（确定性、不发起外部请求）。
 * @returns 包裹后的 streamFn。
 */
function wrapWithFailInject(base: StreamFn): StreamFn {
  return ((model: never, context: never, options: never) =>
    failInjectEnabled
      ? createFailingStream()
      : (base as (m: never, c: never, o: never) => AssistantMessageEventStream)(model, context, options)) as StreamFn;
}

/**
 * 可观测熔断外壳：把内部熔断器的状态跃迁时间戳记录到服务器时钟，
 * 供 /api/__verify/breaker 精确返回 trip / half-open / recovery 时刻（不受客户端轮询间隔影响）。
 *
 * @param inner 内部真实熔断器。
 * @returns 与 CircuitBreaker 同形的可观测外壳（附带 __meta 取内部时间戳）。
 */
function createObservableBreaker(inner: CircuitBreaker) {
  let trippedAt: number | null = null;
  let halfOpenAt: number | null = null;
  let recoveredAt: number | null = null;
  // 维护上一次观测到的状态，统一在任意出口（getState / canAttempt）检测跃迁，
  // 避免遗漏由 getState 惰性触发的 open→half-open 转换。
  let prevState = inner.getState();
  const noteTransition = (next: "closed" | "open" | "half-open"): void => {
    if (next === "open" && prevState !== "open") trippedAt = Date.now();
    if (next === "half-open" && prevState !== "half-open") halfOpenAt = Date.now();
    if (next === "closed" && prevState !== "closed" && halfOpenAt !== null) recoveredAt = Date.now();
    prevState = next;
  };
  return {
    getState(): "closed" | "open" | "half-open" {
      const next = inner.getState();
      noteTransition(next);
      return next;
    },
    canAttempt(): boolean {
      const result = inner.canAttempt();
      noteTransition(inner.getState());
      return result;
    },
    recordSuccess(): void {
      inner.recordSuccess();
      noteTransition(inner.getState());
    },
    recordFailure(): void {
      inner.recordFailure();
      noteTransition(inner.getState());
    },
    /** 暴露内部时间戳，仅诊断端点使用。 */
    __meta: () => ({ trippedAt, halfOpenAt, recoveredAt, state: inner.getState() })
  };
}

/** 验证专用端口（避开生产 / 集成测试端口）。 */
const PORT = Number(process.env.AIAGENT_VERIFY_PORT ?? 3211);
const HOST = "127.0.0.1";

// 1) 内存事实源：无需 Postgres / Redis，离线即可跑通 run / SSE 全链路。
const runtime = createInMemoryApiTestRuntime();

// 2) 把 test-double 的 streamFn 替换为可注入故障的版本。
const baseEntry = runtime.modelRegistry.resolve("test-double");
if (baseEntry && baseEntry.streamFn) {
  baseEntry.streamFn = wrapWithFailInject(baseEntry.streamFn as StreamFn);
}

// 3) 可观测熔断器：阈值与冷却窗口由 env 注入，缺省保守默认。
const breaker = createObservableBreaker(
  createCircuitBreaker({
    failureThreshold: envInt("AIAGENT_VERIFY_CB_FAILURES"),
    cooldownMs: envInt("AIAGENT_VERIFY_CB_COOLDOWN_MS")
  }) as CircuitBreaker
);

const app = createApiServer({
  modelRegistry: runtime.modelRegistry,
  tools: createDefaultToolRegistry().list(),
  identityService: runtime.identityService,
  dataSourceRuntime: runtime.dataSourceRuntime,
  attachmentRepository: runtime.attachmentRepository,
  attachmentStore: runtime.attachmentStore,
  embeddingClient: runtime.embeddingClient,
  citationRepository: runtime.citationRepository,
  requireIdentity: true,
  workflowRepository: runtime.workflowRepository,
  artifactRepository: runtime.artifactRepository,
  conversationRepository: runtime.conversationRepository,
  messageStore: runtime.messageStore,
  runStore: runtime.runStore,
  // 写类（有副作用）工具名集合：与 server.ts 保持一致，避免续跑重复副作用。
  writeToolNames: ["generate_report"],
  // 注入可观测熔断器，使 run 执行路径与熔断观测共用同一实例。
  circuitBreaker: breaker as unknown as CircuitBreaker,
  // 内存模式 readiness 恒 ok。
  readiness: async () => ({ ok: true, dependency: "in-memory", message: "capacity baseline verify mode" })
});

// 4) 诊断端点：仅当 AIAGENT_VERIFY_MODE=1 时注册（默认关闭，避免误暴露）。
if (process.env.AIAGENT_VERIFY_MODE === "1") {
  app.get("/api/__verify/breaker", async () => breaker.__meta());
  app.get("/api/__verify/fail-inject", async () => ({ enabled: failInjectEnabled }));
  app.post("/api/__verify/fail-inject", async (request) => {
    const body = (request as { body?: { enabled?: boolean } }).body;
    if (body && typeof body.enabled === "boolean") failInjectEnabled = body.enabled;
    return { enabled: failInjectEnabled };
  });
}

void app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[verify-server] listening on http://${HOST}:${PORT} (failInject=${failInjectEnabled})`);
});
