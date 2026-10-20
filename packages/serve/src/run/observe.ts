/**
 * 观测型 run 的生命周期（docs/v1.4/02-web-llm-trace.md 的 W2）。
 *
 * 为什么需要它（D1）：默认 `ohna` 仍在 CLI 本地跑 agentLoop（steering / follow-up /
 * TUI 权限卡 / 预算钩子都依赖那条执行线），但 Web 观测台要看到同一份 trace。
 * 于是 serve 提供一个**只写观测面**的入口：CLI 把 loop 事件与 `llm_call` 记录 push
 * 进来，RunManager 用与托管 run 完全相同的 sequence / 落盘 / 广播语义处理。
 *
 * 与托管 run 的两个刻意差异：
 * 1. **不写会话消息**：CLI 自己已经落盘线性消息，这里再写会双份（TC-W2-02）；
 * 2. **不持有执行权**：终态由 CLI 调 `end()` 显式给出，而不是 loop 事件驱动。
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@aiagent/agent";
import type {
  RunEventTypeDto,
  RunSnapshotDtoV2,
  RunStatusDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import type { LocalMessageStore, LocalRunStore, LocalSessionStore } from "../store/index.js";
import type { ActiveRun, ObserveRunInput, ObservedRun, RunErrorPayload } from "./types.js";

/** 观测型 run 需要的 RunManager 内部能力（由 RunManager 绑定后注入）。 */
export interface ObservedRunDeps {
  /** 当前模型 id（写入 run_meta，Web 侧展示用）。 */
  modelId: string;
  workspaceRoot: string;
  runStore: LocalRunStore;
  sessionStore: LocalSessionStore;
  messageStore: LocalMessageStore;
  /** 活跃 run 表（与托管 run 共用，cancel / shutdown / 快照查询天然生效）。 */
  active: Map<string, ActiveRun>;
  /** 会话级订阅表（CLI run 同样推给 `--web` 终端）。 */
  conversationSubscribers: Map<string, Set<(event: RunStreamEventDtoV2) => void>>;
  /** 分配 sequence + 落盘 + 广播。 */
  emitFrame: (run: ActiveRun, type: RunEventTypeDto, payload: unknown) => Promise<void>;
  /** 正常收尾：发 run_status + 标记存储状态。 */
  finishStatus: (run: ActiveRun, status: RunStatusDtoV2, error?: RunErrorPayload) => Promise<void>;
  /** 兜底收尾：落盘失败时直接推进内存终态，避免永远 running。 */
  forceTerminal: (run: ActiveRun, status: RunStatusDtoV2, error?: RunErrorPayload) => Promise<void>;
}

/**
 * 创建一次观测型 run 并返回句柄。
 *
 * @param deps RunManager 绑定的内部能力。
 * @param input 会话 id / 请求 id / 标题。
 * @returns 可 push / end 的观测句柄。
 */
export async function startObservedRun(
  deps: ObservedRunDeps,
  input: ObserveRunInput
): Promise<ObservedRun> {
  await ensureConversation(deps, input);

  const runId = randomUUID();
  const requestId = input.requestId ?? randomUUID();
  const createdAt = new Date().toISOString();

  await deps.runStore.create({
    runId,
    requestId,
    conversationId: input.conversationId,
    modelId: deps.modelId,
    mode: "observe",
    source: "cli",
    // 观测型 run 不落消息，userMessageId 无实际指向，保持空串（与 DTO 的向后兼容一致）。
    userMessageId: "",
    createdAt
  });

  const snapshot: RunSnapshotDtoV2 = {
    runId,
    requestId,
    conversationId: input.conversationId,
    userMessageId: "",
    modelId: deps.modelId,
    mode: "observe",
    source: "cli",
    status: "running",
    lastEventSequence: 0,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt
  };

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const run: ActiveRun = {
    snapshot,
    requestId,
    controller: new AbortController(),
    done,
    sequence: 0,
    lastPersistedSequence: 0,
    subscribers: new Set(),
    terminal: false,
    // 观测型 run 不落消息，该标志只影响 persistRunMessage（此处从不调用）。
    skipFirstUserMessage: true
  };
  deps.active.set(runId, run);

  // 会话级订阅：CLI run 与托管 run 在终端 / SSE 层不可区分。
  const conversationListeners = deps.conversationSubscribers.get(input.conversationId);
  if (conversationListeners) {
    for (const listener of conversationListeners) run.subscribers.add(listener);
  }

  let ending = false;
  /** 推送失败计数：观测镜像失败不打断 CLI，但必须留下可排查痕迹。 */
  let droppedCount = 0;
  let warnedDrop = false;

  /**
   * 记录一次丢弃：首次失败写 stderr，之后只累计（避免刷屏）。
   */
  const recordDrop = (error: unknown): void => {
    droppedCount += 1;
    if (warnedDrop) return;
    warnedDrop = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `⚠️ 观测事件写入失败（已降级，仅计数；dropped=${droppedCount}）：${message}\n`
    );
  };

  return {
    runId,

    push(event) {
      if (run.terminal || ending) return;
      const type = event.type as RunEventTypeDto;
      const payload = event.type === "llm_call" ? event.payload : (event as AgentEvent);
      // push 是同步契约：emitFrame 会**同步**分配 sequence，保证 llm_call 与 loop 事件
      // 的先后顺序稳定；落盘/广播的异步部分失败只计数，不影响 CLI。
      try {
        void deps.emitFrame(run, type, payload).catch(recordDrop);
      } catch (error) {
        // 观测链路故障不得打断 CLI（与 subscriber 广播失败吞掉语义一致）。
        recordDrop(error);
      }
    },

    end(result) {
      if (ending || run.terminal) return;
      ending = true;
      const status: RunStatusDtoV2 = result?.failed ? "failed" : "completed";
      void deps
        .finishStatus(run, status, result?.error)
        .catch(async () => {
          // 落盘失败（磁盘满等）：直接推进内存终态，GET / SSE 仍能看到明确结束。
          await deps.forceTerminal(run, status, result?.error).catch(() => undefined);
        })
        .finally(() => {
          resolveDone();
        });
    }
  };
}

/**
 * 确保目标会话存在：CLI 正常路径会先建会话，这里只兜底进程内直接调用的情况。
 *
 * @param deps store 端口。
 * @param input 观测输入。
 */
async function ensureConversation(deps: ObservedRunDeps, input: ObserveRunInput): Promise<void> {
  const existing = await deps.sessionStore.get(input.conversationId);
  if (existing) return;
  const meta = await deps.sessionStore.create({
    id: input.conversationId,
    title: input.title?.trim() ? input.title : "CLI 观测会话",
    workspaceRoot: deps.workspaceRoot
  });
  await deps.messageStore.ensureConversation(meta.id, meta.title);
}
