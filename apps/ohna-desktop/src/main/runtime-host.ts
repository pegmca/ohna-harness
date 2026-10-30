/**
 * Runtime 宿主（spec §8.4 / §5.2）：负责 `utilityProcess` 的启停、`MessagePort` 桥接、
 * 请求/响应按 `requestId` 关联、事件向 IPC 订阅者扇出，以及对 worker 崩溃采用有限指数退避重启。
 *
 * 关键设计：本类不直接依赖 Electron，而是依赖注入的 `RuntimeHostTransport`（生产用
 * `utilityProcess.fork` + `MessagePortMain` 实现，单测用内存实现），从而可在 node 下直接驱动
 * 请求路由、事件扇出与崩溃广播的断言。事件扇出带每订阅的有界缓冲（背压），避免慢消费者无限积压。
 */
import {
  PROTOCOL_VERSION,
  type RuntimeEventEnvelope,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RunStreamEventDtoV2,
} from "@aiagent/types";

/** 单次 run 订阅缓冲的事件数上限；超出后丢弃最旧事件并计入 dropped。 */
export const SUBSCRIPTION_BUFFER_LIMIT = 1000;

/** worker 崩溃退出信息。 */
export interface CrashInfo {
  code: number | null;
  signal: string | null;
}

/**
 * 传输层抽象：把 `RuntimeHost` 与具体进程/端口实现解耦。
 * 生产实现用 `utilityProcess.fork` + 移交的 `MessagePortMain`；单测用内存桩。
 */
export interface RuntimeHostTransport {
  /** 启动传输（拉起进程 / 建立端口）。 */
  start(): Promise<void>;
  /** 发送请求信封到 worker。 */
  postRequest(envelope: RuntimeRequestEnvelope): void;
  /** 注册响应回调。 */
  onResponse(cb: (envelope: RuntimeResponseEnvelope) => void): void;
  /** 注册事件回调。 */
  onEvent(cb: (envelope: RuntimeEventEnvelope) => void): void;
  /** 注册 worker 崩溃回调（正常退出也会触发，由调用方区分 code）。 */
  onCrash(cb: (info: CrashInfo) => void): void;
  /** 停止传输（杀进程 / 关闭端口）。 */
  stop(): Promise<void>;
}

/** `RuntimeHost` 构造参数。 */
export interface RuntimeHostOptions {
  /** 传输工厂：崩溃重启时重新创建一份传输。 */
  createTransport: () => RuntimeHostTransport;
  /** 不可用回调（放弃重启时广播）。 */
  onUnavailable?: () => void;
  /** 最大重启次数（不含首次启动），默认 5。 */
  maxRetries?: number;
  /** 退避基毫秒，默认 200ms（指数 2 倍，封顶）。 */
  baseBackoffMs?: number;
  /** 退避上限毫秒，默认 5000ms。 */
  maxBackoffMs?: number;
}

/** 单个订阅的背压缓冲状态。 */
interface SubscriptionState {
  onEvent: (event: RunStreamEventDtoV2) => void;
  buffer: RunStreamEventDtoV2[];
  draining: boolean;
  dropped: number;
}

/**
 * Runtime 宿主：单一 runtime 实例的进程编排者。
 *
 * 职责边界（spec §2.1）：主进程只做原生授权与 IPC 路由，不直接实现 Agent / 会话 / run / 存储；
 * 真正的执行核在 worker 内的 `OhnaRuntime`。本类负责把信封转发到 worker 并把事件扇出回 IPC。
 */
export class RuntimeHost {
  private transport: RuntimeHostTransport | undefined;
  private readonly pending = new Map<string, (envelope: RuntimeResponseEnvelope) => void>();
  private readonly subscribers = new Map<string, SubscriptionState>();
  private readonly unavailableCbs = new Set<() => void>();
  private retries = 0;
  private stopped = false;
  private available = false;

  /** @param options 传输工厂与退避参数。 */
  constructor(private readonly options: RuntimeHostOptions) {}

  /**
   * 启动传输并接线响应/事件/崩溃回调；连续崩溃超过上限后放弃并广播不可用。
   *
   * @returns 启动完成的 Promise。
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.bootTransport();
  }

  /**
   * 启动一份传输并接线回调；若启动过程中 worker 崩溃且已耗尽重试，则广播不可用。
   *
   * @returns 无返回值。
   */
  private async bootTransport(): Promise<void> {
    const transport = this.options.createTransport();
    this.transport = transport;
    transport.onResponse((envelope) => this.handleResponse(envelope));
    transport.onEvent((envelope) => this.handleEvent(envelope));
    transport.onCrash((info) => void this.handleCrash(info));
    await transport.start();
    this.available = true;
  }

  /**
   * 发送一个请求并等待对应 `requestId` 的响应。
   *
   * 传输未就绪（未启动 / 已放弃）时直接返回 `runtime_unavailable`，不抛异常、不挂起。
   * 协议版本在发送前强制对齐本端，未知窗口/越权由上层（ipc.ts）拦截。
   *
   * @param request 请求信封（method / payload）。
   * @returns 结构化响应信封。
   */
  request(request: Omit<RuntimeRequestEnvelope, "protocolVersion">): Promise<RuntimeResponseEnvelope> {
    if (!this.transport || !this.available) {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: { code: "runtime_unavailable", message: "runtime 不可用", requestId: request.requestId }
      });
    }
    const envelope: RuntimeRequestEnvelope = { protocolVersion: PROTOCOL_VERSION, ...request };
    return new Promise<RuntimeResponseEnvelope>((resolve) => {
      this.pending.set(request.requestId, resolve);
      this.transport!.postRequest(envelope);
    });
  }

  /**
   * 登记一个事件订阅者，返回退订函数（仅清理本端缓冲与映射，worker 侧释放由 ipc 层触发）。
   *
   * @param subscriptionId 订阅幂等键。
   * @param onEvent 事件回调。
   * @returns 退订函数。
   */
  subscribe(subscriptionId: string, onEvent: (event: RunStreamEventDtoV2) => void): () => void {
    this.subscribers.set(subscriptionId, { onEvent, buffer: [], draining: false, dropped: 0 });
    return () => {
      this.subscribers.delete(subscriptionId);
    };
  }

  /**
   * 获取某订阅当前缓冲长度（单测断言背压上限用）。
   *
   * @param subscriptionId 订阅幂等键。
   * @returns 缓冲中的事件数。
   */
  getSubscriptionBufferSize(subscriptionId: string): number {
    return this.subscribers.get(subscriptionId)?.buffer.length ?? 0;
  }

  /**
   * 获取某订阅因背压丢弃的事件数。
   *
   * @param subscriptionId 订阅幂等键。
   * @returns 丢弃事件计数。
   */
  getSubscriptionDropped(subscriptionId: string): number {
    return this.subscribers.get(subscriptionId)?.dropped ?? 0;
  }

  /**
   * 注册 runtime 不可用回调（放弃重启后广播）。
   *
   * @param cb 不可用回调。
   @returns 取消注册函数。
   */
  onUnavailable(cb: () => void): () => void {
    this.unavailableCbs.add(cb);
    return () => this.unavailableCbs.delete(cb);
  }

  /**
   * 停止宿主：清理所有挂起请求、订阅与传输，放弃重启。
   *
   * @returns 停止完成的 Promise。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.available = false;
    this.pending.clear();
    this.subscribers.clear();
    if (this.transport) {
      await this.transport.stop();
      this.transport = undefined;
    }
  }

  /**
   * 处理 worker 响应：按 requestId 关联并 resolve 挂起请求。
   *
   * @param envelope 响应信封。
   */
  private handleResponse(envelope: RuntimeResponseEnvelope): void {
    const resolve = this.pending.get(envelope.requestId);
    if (!resolve) return;
    this.pending.delete(envelope.requestId);
    resolve(envelope);
  }

  /**
   * 处理 worker 事件：按 subscriptionId 扇出到订阅者，带每订阅有界缓冲（背压）。
   *
   * @param envelope 事件信封。
   */
  private handleEvent(envelope: RuntimeEventEnvelope): void {
    const state = this.subscribers.get(envelope.subscriptionId);
    if (!state) return;
    state.buffer.push(envelope.event);
    if (state.buffer.length > SUBSCRIPTION_BUFFER_LIMIT) {
      state.buffer.shift();
      state.dropped += 1;
    }
    this.scheduleDrain(envelope.subscriptionId, state);
  }

  /**
   * 调度一次缓冲排空；setImmediate 分批调用，避免一次事件洪流阻塞主线程，
   * 同时让慢消费者自然形成背压（缓冲达到上限后丢旧事件）。
   *
   * @param subscriptionId 订阅幂等键。
   * @param state 订阅状态。
   */
  private scheduleDrain(subscriptionId: string, state: SubscriptionState): void {
    if (state.draining) return;
    state.draining = true;
    setImmediate(() => {
      const current = this.subscribers.get(subscriptionId);
      if (!current) {
        // 订阅在排空回调执行前被移除：必须复位 draining，否则旧 state 永久卡死；
        // 若同 id 之后重新登记，新的排空调度会被 `draining` 拦截，事件不再投递。
        state.draining = false;
        return;
      }
      try {
        // 一轮内把当前缓冲全部投递：逐事件 setImmediate 会在订阅/窗口重建时留下
        // draining=true 的悬挂状态，导致后续事件永久不再排空（UI 卡 running）。
        while (current.buffer.length > 0) {
          const event = current.buffer.shift();
          if (!event) break;
          try {
            current.onEvent(event);
          } catch {
            // 渲染端回调异常不应污染宿主事件循环。
          }
        }
      } finally {
        // 以当前登记表为准复位；期间新增事件会重新触发 handleEvent -> scheduleDrain。
        const latest = this.subscribers.get(subscriptionId);
        if (latest === current) current.draining = false;
        else state.draining = false;
      }
      // 排空期间若又有新事件进入，重新调度一次。
      const latest = this.subscribers.get(subscriptionId);
      if (latest && latest.buffer.length > 0) this.scheduleDrain(subscriptionId, latest);
    });
  }

  /**
   * 处理 worker 崩溃：有限指数退避重启；连续超过上限则放弃并广播不可用。
   *
   * @param info 退出码 / 信号。
   */
  private async handleCrash(info: CrashInfo): Promise<void> {
    this.available = false;
    // 正常退出（code 0）且非主动停止：也算一次不可服务，按崩溃处理但不无限重生。
    if (this.stopped) return;
    const maxRetries = this.options.maxRetries ?? 5;
    if (this.retries >= maxRetries) {
      this.broadcastUnavailable();
      return;
    }
    const base = this.options.baseBackoffMs ?? 200;
    const cap = this.options.maxBackoffMs ?? 5000;
    const delay = Math.min(base * 2 ** this.retries, cap);
    this.retries += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.stopped) return;
    await this.bootTransport();
  }

  /**
   * 广播 runtime 不可用：向所有挂起请求返回 `runtime_unavailable`，并通知已注册回调。
   */
  private broadcastUnavailable(): void {
    for (const [requestId, resolve] of this.pending) {
      resolve({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: { code: "runtime_unavailable", message: "runtime 已不可用", requestId }
      });
    }
    this.pending.clear();
    if (this.options.onUnavailable) this.options.onUnavailable();
    for (const cb of this.unavailableCbs) cb();
  }
}
