/**
 * 会话生命周期编排：打开/恢复 → 压缩 → 落盘 → 提示恢复命令。
 *
 * 与 session-store（纯 JSONL 读写）、session-runtime（摘要器与压缩原语）分层：
 * 本模块只负责「什么时候保存、保存什么、失败如何提示」，不关心文件格式与摘要实现。
 * 拆出它的直接原因是 harness 超过 500 行纪律。它是 CLI 应用层编排，不供 packages/serve 引用
 * （应用层互不依赖）；serve 的会话语义在 Phase 2 由包内 store 按同一契约重新实现。
 */
import type { ActiveModel } from "@aiagent/ai";
import type { AgentMessage } from "@aiagent/agent";
import * as path from "node:path";
import type { UsageSnapshot, UsageTracker } from "../ui/render.js";
import { write } from "../ui/render.js";
import {
  compactSessionHistory,
  filterFailedAssistants,
  type SessionSummarizer,
} from "./session-runtime.js";
import type { SessionStore } from "./session-store.js";

/**
 * `--resume` / `/resume <id>` 默认只解码的尾部消息条数（Phase C4）。
 *
 * 取舍：大会话（数千条）常见的恢复场景只关心最近上下文与首帧速度，尾部 80 条足以
 * 覆盖屏幕可见范围；完整历史在 `/export`、`/resume fork` 等显式需要时再全量 `load`。
 */
export const RESUME_TAIL_MESSAGES = 80;

/** 打开/恢复会话的结果。 */
export interface OpenedSession {
  /** 会话 id（同时是文件名）。 */
  id: string;
  /** 会话标题；新建会话为 undefined，待首条用户输入固定。 */
  title?: string;
  /** 历史消息（含 CompactionMessage）；`hasMore=true` 时只是磁盘历史的尾部后缀。 */
  messages: AgentMessage[];
  /** 累计用量快照（用于恢复 /cost 与 --max-cost）。 */
  usage?: UsageSnapshot;
  /**
   * 是否还有更早的历史未解码（Phase C4 尾部恢复）。
   *
   * `true` 表示 `messages` 只是严格后缀，任何落盘前都必须先 {@link ensureFullHistory}，
   * 否则 `save` 会用后缀覆盖整个 JSONL，永久截断更早消息。
   */
  hasMore: boolean;
}

/**
 * 解析恢复会话：`--resume` 失效（不存在 / id 非法）时告警并回退为新建。
 *
 * @param store 会话存储。
 * @param resumeId 用户传入的会话 id。
 * @param cwd 工作区根目录。
 * @returns 恢复或新建的会话。
 */
export async function openSession(
  store: SessionStore,
  resumeId: string | undefined,
  cwd: string,
): Promise<OpenedSession> {
  if (resumeId) {
    try {
      // C4：只解码尾部 80 条，避免大会话在启动 / 恢复时全量 JSON.parse。
      // `hasMore=true` 时更早的消息仍在磁盘上；需要完整历史（导出 / fork）的调用点
      // 必须显式走 store.load，不能依赖这里的 history。
      const record = await store.loadSessionTail(resumeId, RESUME_TAIL_MESSAGES);
      if (record) {
        warnWorkspaceMismatch(record.meta.workspaceRoot, cwd, record.meta.id);
        return {
          id: record.meta.id,
          // 「新会话」只是新建占位标题，恢复后仍应允许首条真实输入覆盖它。
          title: record.meta.title === "新会话" ? undefined : record.meta.title,
          messages: filterFailedAssistants(record.messages),
          usage: record.meta.usage,
          // 尾读的 hasMore 必须透传：调用点据此决定何时补载完整历史。
          hasMore: record.hasMore,
        };
      }
      process.stderr.write(`未找到会话 "${resumeId}"，已改为新建会话。\n`);
    } catch (error) {
      process.stderr.write(
        `恢复会话失败（${error instanceof Error ? error.message : String(error)}），已改为新建会话。\n`,
      );
    }
  }
  const meta = await store.create({ workspaceRoot: cwd });
  // 新建会话不预设标题：首条用户输入到达时才固定，避免把「新会话」写成永久标题。
  return { id: meta.id, title: undefined, messages: [], usage: undefined, hasMore: false };
}

/**
 * 把 tail 恢复的会话补载为完整历史（Phase C4 数据丢失修复）。
 *
 * 为什么需要它：`openSession` 为了首帧速度只解码尾部 n 条，但 `persistSession` 是覆盖式
 * `save`。若把尾部后缀直接写回 JSONL，更早的消息会被永久截断。职责边界是「在真正需要
 * 完整上下文 / 落盘之前补全内存历史」，而不是让 store 隐式做全量读取（否则 tail 优化失效）。
 *
 * 语义与 `openSession` 保持一致：补载后同样过滤 error/aborted assistant，避免无效消息
 * 在下一轮被重新发给模型。读取失败时不修改内存历史，调用方必须视为「尚未补载」并跳过落盘。
 *
 * @param store 会话存储。
 * @param sessionId 当前会话 id。
 * @param history 待补全的历史数组（原地替换，保持闭包引用稳定）。
 * @param onWarn 可选的失败提示回调（REPL 走 write、单次模式走 stderr）。
 * @returns 是否成功补载；`false` 表示磁盘不可读，内存仍是原来的（可能是尾部的）历史。
 */
export async function ensureFullHistory(
  store: SessionStore,
  sessionId: string,
  history: AgentMessage[],
  onWarn?: (message: string) => void,
): Promise<boolean> {
  try {
    const record = await store.load(sessionId);
    if (!record) {
      onWarn?.(`无法读取会话 ${sessionId} 的完整历史。`);
      return false;
    }
    replaceHistory(history, filterFailedAssistants(record.messages));
    return true;
  } catch (error) {
    onWarn?.(
      `补载会话 ${sessionId} 的完整历史失败（${error instanceof Error ? error.message : String(error)}）。`,
    );
    return false;
  }
}

/**
 * 恢复会话时校验工作区：历史里的相对路径只对原工作区有意义，跨目录恢复必须明确提示。
 *
 * 取舍：只告警不阻断——用户可能刻意在新目录里参考旧会话；工具作用域始终以当前 cwd 为准。
 *
 * @param storedRoot 会话元数据里的工作区根目录。
 * @param cwd 当前进程工作目录。
 * @param sessionId 会话 id（提示文案用）。
 */
function warnWorkspaceMismatch(storedRoot: string, cwd: string, sessionId: string): void {
  if (!storedRoot) {
    process.stderr.write(
      `⚠ 会话 ${sessionId} 缺少工作区信息，无法确认历史路径归属；工具仍以当前目录 ${cwd} 为作用域。\n`,
    );
    return;
  }
  if (path.resolve(storedRoot) !== path.resolve(cwd)) {
    process.stderr.write(
      `⚠ 会话 ${sessionId} 的工作区为 ${storedRoot}，与当前目录 ${cwd} 不一致：` +
        "历史中的相对路径可能不属于当前工作区，工具仍以当前目录为作用域。\n",
    );
  }
}

/** 会话落盘所需的上下文。 */
export interface PersistSessionContext {
  /** 当前模型（取 contextWindow 决定压缩阈值）。 */
  model: ActiveModel["model"];
  /** 严格摘要器（失败时保存未压缩版本）。 */
  summarizer: SessionSummarizer;
  /** 会话标题（首条用户输入固定）。 */
  title?: string;
  /** 工作区根目录。 */
  workspaceRoot: string;
  /** 会话级用量累计器。 */
  usage: UsageTracker;
}

/**
 * 会话级压缩 + 落盘。
 *
 * 先对全量 history 跑 shouldCompact/compact（跨 run 语义），再把结果写回 JSONL；
 * 压缩失败只告警、不阻断保存（保存未压缩版本）。返回压缩后的 history 供内存同步替换。
 *
 * C4 数据安全：`save` 是覆盖式写。若 history 来自 `loadSessionTail`（`hasMore=true`），
 * 调用方必须先 `ensureFullHistory` 补全，否则尾部后缀会覆盖掉磁盘上的更早消息；
 * 本函数不隐式全量读取，以保持 tail 首帧优化。
 *
 * @param store 会话存储。
 * @param sessionId 当前会话 id。
 * @param history 全量 history。
 * @param context 压缩与保存所需的模型 / 标题 / 用量。
 * @returns 可能被压缩替换的 history。
 */
export async function persistSession(
  store: SessionStore,
  sessionId: string,
  history: AgentMessage[],
  context: PersistSessionContext,
): Promise<AgentMessage[]> {
  // 先过滤 error/aborted assistant：它们既无有效内容，也不应跨进程恢复后再次发给模型。
  const savable = filterFailedAssistants(history);
  const compaction = await compactSessionHistory(savable, {
    model: context.model,
    summarizer: context.summarizer,
    onWarn: (message) => process.stderr.write(`${message}\n`),
  });
  if (compaction.compacted) {
    const hard = compaction.truncatedMessages + compaction.droppedMessages;
    // 走 write()：整屏模式下压缩提示会被 sink 收进对话模型，直写 stdout 会被下一帧清屏抹掉。
    write(
      `↺ 会话上下文已压缩：约 ${compaction.tokensBefore} → ${compaction.tokensAfter} token / ` +
        `${compaction.messageCountBefore} 条 → ${compaction.messages.length} 条` +
        (hard > 0 ? `（硬收敛：截断 ${compaction.truncatedMessages} 条 / 丢弃 ${compaction.droppedMessages} 条）` : "") +
        "\n",
    );
  }
  try {
    await store.save(sessionId, compaction.messages, {
      title: context.title,
      workspaceRoot: context.workspaceRoot,
      usage: context.usage.snapshot(),
    });
  } catch (error) {
    process.stderr.write(
      `会话保存失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return compaction.messages;
}

/**
 * 用新序列替换数组内容（保持引用，让 REPL 闭包与 history 指向同一数组）。
 *
 * @param target 原数组。
 * @param next 新序列。
 */
export function replaceHistory(target: AgentMessage[], next: AgentMessage[]): void {
  target.length = 0;
  target.push(...next);
}

/**
 * 打印会话 id 与恢复命令。
 *
 * 恢复命令只需带上会话 id。
 *
 * @param sessionId 会话 id。
 */
export function printResumeHint(sessionId: string): void {
  process.stdout.write(`\n会话已保存：${sessionId}\n恢复：ohna --resume ${sessionId}\n`);
}
