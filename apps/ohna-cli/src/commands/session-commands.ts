/**
 * 会话内命令实现（/tools /model /compact /resume）：把 REPL 的「命令副作用」从输入循环中析出。
 *
 * 单一形态（docs/v1.4/06 D-A1/A3）：会话持久化已收敛到 serve，本模块不再触碰本地 JSONL。
 * 读类命令（/resume 列表与切换、/export、/compact 的载入）改经 `serve-session` 适配器读
 * serve 消息；写类动作（切换 / fork / clear）只更新 REPL 的内存状态并由 serve 持久化。
 * 纯 UI / 本地偏好命令（/help、/model、/cost、/tools、/mcp、/permissions、/verbose）留本地。
 */
import { listAvailableModelProfiles, resolveActiveModelFromEnv, type ActiveModel } from "@aiagent/ai";
import type { AgentMessage } from "@aiagent/agent";
import type { AgentTool } from "@aiagent/tools";
import { compactSessionHistory } from "../runtime/summarizer.js";
import { exportSessionMarkdown } from "../session/session-export.js";
import {
  forkConversation,
  getConversationMeta,
  isLegacySessionId,
  LegacySessionIdError,
  listConversations,
  loadMessages,
} from "../session/serve-session.js";
import { write, type UsageTracker } from "../ui/render.js";
import type { RunSetup } from "../runtime/turn.js";
import type { OhnaServer } from "@aiagent/serve";

/** 会话命令的读写上下文：REPL 持有真实状态，本模块只通过 getter/setter 访问。 */
export interface SessionCommandContext {
  /** 已装配的工具列表（/tools 展示）。 */
  tools: readonly AgentTool<any>[];
  /** MCP 工具名（/tools 来源标注）。 */
  mcpToolNames?: ReadonlySet<string>;
  /** 已接入的 MCP server 名（/status 与 /mcp 展示）。 */
  mcpServerNames?: readonly string[];
  /** Team 编排工具名（/tools 来源标注）。 */
  teamToolNames?: ReadonlySet<string>;
  /** 进程内 serve 句柄（会话读写统一走它）。 */
  server: OhnaServer;
  /** 数据目录（与托管 serve 实例一致，用于读取消息）。 */
  dataDir?: string;
  /** 会话级用量累计器。 */
  tracker: UsageTracker;
  /** 会话级配置（压缩摘要器 / 工作区等）。 */
  setup: RunSetup;
  /** 当前 history（原地 replace，保持引用稳定）。 */
  history: AgentMessage[];
  /** 读取当前模型。 */
  getModel(): ActiveModel;
  /** 切换当前模型。 */
  setModel(model: ActiveModel): void;
  /** 读取当前会话 id（serve 的 conversationId）。 */
  getSessionId(): string;
  /** 切换当前会话 id。 */
  setSessionId(id: string): void;
  /** 读取会话标题。 */
  getTitle(): string | undefined;
  /** 设置会话标题（undefined 表示回到「新会话」）。 */
  setTitle(title: string | undefined): void;
  /** 读取当前权限预设（/status 快照）；可选，便于只关心历史的调用方不提供。 */
  getPermissionPreset?: () => string;
  /**
   * 读取内存 history 是否为**完整历史**。
   *
   * 单一形态下 history 来自 serve 全量 `loadMessages`，恒为完整，因此默认 true。
   */
  isFullHistoryLoaded?: () => boolean;
  /** 切换会话前清空全量历史标记（/resume 重读 serve 后由调用方重新置真）。 */
  markFullHistoryLoaded?: () => void;
  /**
   * 切换会话成功后的回调整体：REPL 据此退订旧会话、订阅新会话并回放历史。
   *
   * @param id 新会话 id（空串表示「待创建」态，如 /clear）。
   * @param title 新会话标题（undefined 表示新会话）。
   */
  onSessionSwitched?: (id: string, title: string | undefined) => void;
  /**
   * 切会话后重渲染欢迎头。
   */
  onRenderWelcome?: () => void;
}

/**
 * 原地替换 history 数组内容（保持数组引用稳定，REPL 通过 ctx.history 持有同一引用）。
 *
 * @param history 被替换的目标数组（原地修改 length 为 0 后 push）。
 * @param next 新的消息序列。
 */
function replaceHistory(history: AgentMessage[], next: readonly AgentMessage[]): void {
  history.length = 0;
  history.push(...next);
}

/**
 * /tools：列出当前工具名；MCP 工具追加来源标注。
 *
 * @param ctx 会话命令上下文。
 */
export function printTools(ctx: SessionCommandContext): void {
  const mcp = ctx.mcpToolNames;
  const team = ctx.teamToolNames;
  for (const tool of ctx.tools) {
    const source = mcp?.has(tool.name) ? "（MCP）" : team?.has(tool.name) ? "（Team）" : "";
    write(`  ${tool.name}${source}\n`);
  }
  write(`共 ${ctx.tools.length} 个工具。\n`);
}

/**
 * /model：无参列出可用 profile 与当前；带参切换（无效 profile 报错不切换）。
 *
 * @param ctx 会话命令上下文。
 * @param arg profile 名；空串表示仅展示。
 */
export function switchModel(ctx: SessionCommandContext, arg: string): void {
  const current = ctx.getModel();
  if (!arg) {
    const profiles = listAvailableModelProfiles();
    write(`当前模型：${current.model.id}（profile: ${current.model.provider}）\n`);
    write(`可用 profile：${profiles.join("、") || "（无）"}\n`);
    return;
  }
  const chosen = resolveActiveModelFromEnv(arg);
  if (!chosen) {
    write(`未找到 profile "${arg}"（可用：${listAvailableModelProfiles().join("、") || "无"}）。\n`);
    return;
  }
  ctx.setModel(chosen);
  write(`已切换模型：${chosen.model.id}（profile: ${chosen.model.provider}），对后续 run 生效。\n`);
}

/**
 * /compact：立即对当前会话跑一次会话级压缩并打印前后 token。
 *
 * 单一形态下 serve 已在每次 run 前自动压缩（L3-3），此命令提供手动触发入口：
 * 读 serve 全量消息 → 本地摘要 → 覆盖写回 serve 会话（经 store append 压缩摘要）。
 *
 * @param ctx 会话命令上下文。
 */
export async function compactNow(ctx: SessionCommandContext): Promise<void> {
  const model = ctx.getModel();
  if (ctx.history.length === 0) {
    write("当前会话没有历史消息，无需压缩。\n");
    return;
  }
  const result = await compactSessionHistory(ctx.history, {
    model: model.model,
    summarizer: ctx.setup.summarizer,
    onWarn: (message) => process.stderr.write(`${message}\n`),
  });
  if (!result.compacted) {
    write(
      `未触发压缩：当前约 ${result.tokensBefore} token，未超过压缩阈值（窗口 ${model.model.contextWindow}）。\n`,
    );
    return;
  }
  replaceHistory(ctx.history, result.messages);
  write(
    `已压缩：${result.tokensBefore} → ${result.tokensAfter} token / ${result.messageCountBefore} 条 → ${ctx.history.length} 条\n`,
  );
  write("压缩摘要已写入当前会话（serve 持久化）。\n");
}

/**
 * /resume：无参列出最近会话；`<id>` 切换；`fork <id>` 复制旧会话开新会话。
 *
 * @param ctx 会话命令上下文。
 * @param arg 目标会话 id / `fork <id>`；空串表示仅列出。
 */
export async function resumeSession(ctx: SessionCommandContext, arg: string): Promise<void> {
  const trimmed = arg.trim();
  if (!trimmed) {
    const conversations = await listConversations(ctx.server);
    if (conversations.length === 0) {
      write("暂无历史会话。\n");
      return;
    }
    write("最近会话（serve 会话存储）：\n");
    for (const item of conversations.slice(0, 10)) {
      write(`  ${item.conversationId}  ${item.title}  ${item.updatedAt}\n`);
    }
    write("使用 /resume <id> 切换，或 /resume fork <id> 复制为新会话。\n");
    return;
  }

  const [sub, ...rest] = trimmed.split(/\s+/);
  if (sub === "fork") {
    const target = rest[0];
    if (!target) {
      write("用法：/resume fork <id>（先 /resume 查看会话 id）\n");
      return;
    }
    await forkSession(ctx, target);
    return;
  }

  // 旧版 CLI 的本地 JSONL 会话 id（<uuid>.jsonl）无法在 serve 模型下打开。
  if (isLegacySessionId(trimmed)) {
    write(`\n${new LegacySessionIdError(trimmed).message}\n`);
    return;
  }

  try {
    const meta = await getConversationMeta(ctx.dataDir ?? "", trimmed);
    if (!meta) {
      write(`未找到会话 "${trimmed}"，保持当前会话不变。\n`);
      return;
    }
    ctx.setSessionId(meta.id);
    ctx.setTitle(meta.title === "新会话" ? undefined : meta.title);
    ctx.markFullHistoryLoaded?.();
    // REPL 据此退订旧会话、订阅新会话、回放 serve 历史并重渲染欢迎头。
    ctx.onSessionSwitched?.(meta.id, ctx.getTitle());
    write(`已切换到会话 ${meta.id}（标题：${meta.title}）。\n`);
  } catch (error) {
    write(
      `恢复会话失败（${error instanceof Error ? error.message : String(error)}），保持当前会话不变。\n`,
    );
  }
}

/**
 * fork 旧会话：复制消息到新 serve 会话，旧会话保留。
 *
 * @param ctx 会话命令上下文。
 * @param targetId 被 fork 的旧会话 id。
 */
async function forkSession(ctx: SessionCommandContext, targetId: string): Promise<void> {
  try {
    const newId = await forkConversation(ctx.server, ctx.dataDir ?? "", targetId);
    ctx.setSessionId(newId);
    ctx.markFullHistoryLoaded?.();
    ctx.onSessionSwitched?.(newId, undefined);
    write(`已 fork 自 ${targetId}，新会话 ${newId}。\n`);
  } catch (error) {
    write(
      `fork 会话失败（${error instanceof Error ? error.message : String(error)}），保持当前会话不变。\n`,
    );
  }
}

/**
 * /clear：清空上下文并进入「待创建」态（不落盘新会话）。
 *
 * 单一形态下会话由 serve 拥有：清空只重置内存历史与权限会话，并回到 conversationId
 * 空串占位；首条真实消息发送时才由 REPL 经 `server.createConversation` 物化新会话。
 *
 * @param ctx 会话命令上下文。
 */
export async function clearSession(ctx: SessionCommandContext): Promise<void> {
  const previousId = ctx.getSessionId();
  ctx.history.length = 0;
  ctx.tracker.restore({ input: 0, output: 0, total: 0, cost: 0 });
  ctx.setSessionId("");
  ctx.setTitle(undefined);
  // REPL 据此退订旧会话、回到「待创建」态并重渲染欢迎头。
  ctx.onSessionSwitched?.("", undefined);
  write(
    `已清空上下文并进入新会话（旧会话 ${previousId || "（无）"} 保留在 serve 会话存储，发送首条消息后新会话才创建）\n`,
  );
}

/**
 * /status：模型 / 会话 / 消息数 / 用量 / MCP / Team / 权限的一次性快照。
 *
 * @param ctx 会话命令上下文。
 */
export function printStatus(ctx: SessionCommandContext): void {
  const model = ctx.getModel();
  const usage = ctx.tracker.snapshot();
  const reasoning = usage.reasoning ?? 0;
  const output = reasoning > 0 ? `输出 ${usage.output}（推理 ${reasoning}）` : `输出 ${usage.output}`;
  const servers = ctx.mcpServerNames ?? [];
  const mcpTools = ctx.mcpToolNames?.size ?? 0;
  const teamTools = ctx.teamToolNames?.size ?? 0;
  const preset = ctx.getPermissionPreset?.() ?? "未提供";
  write(`模型：${model.model.id}（profile: ${model.model.provider}）\n`);
  write(`会话：${ctx.getSessionId() || "（待创建）"} · ${ctx.getTitle() ?? "新会话"}\n`);
  write(`消息：${ctx.history.length} 条（serve 持久化，本地为完整历史）\n`);
  if (usage.total === 0) {
    write("用量：暂无（本会话尚未产生模型调用）\n");
  } else {
    write(`用量：token ${usage.total}（输入 ${usage.input} / ${output}），成本 $${usage.cost.toFixed(6)}\n`);
  }
  write(`MCP：${servers.length} 个 server（${servers.join("、") || "无"}）· ${mcpTools} 个工具\n`);
  write(`Team：${teamTools > 0 ? `已启用（${teamTools} 个工具）` : "未启用"}\n`);
  write(`权限：${preset}\n`);
}

/**
 * /mcp：列出已接入的 server 与工具；未接入时给出明确的接入方式。
 *
 * @param ctx 会话命令上下文。
 */
export function printMcp(ctx: SessionCommandContext): void {
  const servers = ctx.mcpServerNames ?? [];
  const tools = [...(ctx.mcpToolNames ?? [])];
  if (servers.length === 0 && tools.length === 0) {
    write("未接入 MCP server（启动时使用 --mcp <config.json> 接入）。\n");
    return;
  }
  write(`MCP server（${servers.length}）：\n`);
  for (const server of servers) write(`  - ${server}\n`);
  write(`工具（${tools.length}）：${tools.join("、") || "（无）"}\n`);
}

/**
 * /export：把当前会话的**完整历史**导出为 Markdown，并打印写入路径。
 *
 * 单一形态下历史来自 serve；从 serve 全量 `loadMessages` 读取，避免只导出内存尾部。
 *
 * @param ctx 会话命令上下文。
 */
export async function exportSession(ctx: SessionCommandContext): Promise<void> {
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    write("当前还没有会话（发送首条消息后才会创建），无法导出。\n");
    return;
  }
  let messages = ctx.history;
  let title = ctx.getTitle();
  try {
    const loaded = await loadMessages(ctx.dataDir ?? "", sessionId);
    if (loaded.length > 0) messages = loaded;
  } catch {
    // 读取失败不阻断导出：降级为当前内存 history。
  }
  const result = await exportSessionMarkdown({
    sessionId,
    ...(title !== undefined ? { title } : {}),
    model: ctx.getModel().model.id,
    messages,
    usage: ctx.tracker.snapshot(),
  });
  if (result.ok) {
    write(`已导出到 ${result.path}\n`);
  } else {
    write(`导出失败：${result.reason}\n`);
  }
}
