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
import type { UsageSnapshot, UsageTracker } from "./render.js";
import { write } from "./render.js";
import {
  compactSessionHistory,
  filterFailedAssistants,
  type SessionSummarizer,
} from "./session-runtime.js";
import type { SessionStore } from "./session-store.js";

/** 打开/恢复会话的结果。 */
export interface OpenedSession {
  /** 会话 id（同时是文件名）。 */
  id: string;
  /** 会话标题；新建会话为 undefined，待首条用户输入固定。 */
  title?: string;
  /** 历史消息（含 CompactionMessage）。 */
  messages: AgentMessage[];
  /** 累计用量快照（用于恢复 /cost 与 --max-cost）。 */
  usage?: UsageSnapshot;
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
      const record = await store.load(resumeId);
      if (record) {
        warnWorkspaceMismatch(record.meta.workspaceRoot, cwd, record.meta.id);
        return {
          id: record.meta.id,
          // 「新会话」只是新建占位标题，恢复后仍应允许首条真实输入覆盖它。
          title: record.meta.title === "新会话" ? undefined : record.meta.title,
          messages: filterFailedAssistants(record.messages),
          usage: record.meta.usage,
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
  return { id: meta.id, title: undefined, messages: [], usage: undefined };
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
