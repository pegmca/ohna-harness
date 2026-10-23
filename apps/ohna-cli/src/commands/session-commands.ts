/**
 * 会话内命令实现（/tools /model /compact /resume）：把 REPL 的「命令副作用」从输入循环中析出。
 *
 * 为什么需要上下文对象：这些命令要读写跨轮会话状态（history / model / sessionId / title /
 * tracker），但 REPL 用闭包持有它们。用显式 getter/setter 传入，既避免把整个 runRepl
 * 闭包搬进模块，也让每个命令的输入输出一眼可见（repl.ts 只保留装配与分发）。
 */
import { listAvailableModelProfiles, resolveActiveModelFromEnv, type ActiveModel } from "@aiagent/ai";
import type { AgentMessage } from "@aiagent/agent";
import type { AgentTool } from "@aiagent/tools";
import { compactSessionHistory } from "../session/session-runtime.js";
import { exportSessionMarkdown } from "../session/session-export.js";
import {
  ensureFullHistory,
  PENDING_SESSION_ID,
  persistSession,
  replaceHistory,
} from "../session/session-flow.js";
import { createSessionStore } from "../session/session-store.js";
import { resetPresentation, write, type UsageTracker } from "../ui/render.js";
import type { RunSetup } from "../runtime/turn.js";

/** 本地会话存储（JSONL）的类型别名，避免在上下文里重复 ReturnType 推导。 */
type SessionStore = ReturnType<typeof createSessionStore>;

/**
 * 会话命令的读写上下文：REPL 持有真实状态，本模块只通过 getter/setter 访问。
 *
 * 用 getter/setter 而不是快照值：当前模型、会话 id / 标题在 /model、/resume、/clear
 * 之后会变化，闭包读取才能让命令看到最新值。
 */
export interface SessionCommandContext {
  /** 已装配的工具列表（/tools 展示）。 */
  tools: readonly AgentTool<any>[];
  /** MCP 工具名（/tools 来源标注）。 */
  mcpToolNames?: ReadonlySet<string>;
  /** 已接入的 MCP server 名（/status 与 /mcp 展示）。 */
  mcpServerNames?: readonly string[];
  /** Team 编排工具名（/tools 来源标注）。 */
  teamToolNames?: ReadonlySet<string>;
  /** 会话存储。 */
  store: SessionStore;
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
  /** 读取当前会话 id。 */
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
   * 读取内存 history 是否为**完整历史**（M2 的 /status 文案）。
   *
   * tail 恢复（`--resume`）后内存 history 只是磁盘历史的尾部后缀（最多 80 条），
   * 此时不能把 `history.length` 当作会话消息总数展示。可选；未提供时按「已完整」处理。
   */
  isFullHistoryLoaded?: () => boolean;
  /**
   * 切换会话成功后的清理钩子（B2）：会话级权限规则不得泄漏到新会话。
   * 可选，便于只关心历史的调用方（如测试）不强制提供。
   */
  onSessionSwitched?: () => void;
  /**
   * 补载完整历史（C4 数据安全）：tail 恢复后 /compact 压缩并落盘前必须调用。
   * REPL 注入自己的加载器（内含「已补载」短路）；未注入时命令模块回退到
   * `ensureFullHistory`（直接 store.load + replaceHistory），不依赖 REPL。
   * 失败时应 reject，让 /compact 放弃落盘。
   */
  ensureFullHistory?: () => Promise<void>;
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
    // 来源标注互斥：Team 工具由本进程注册，不会被列入 MCP 发现结果。
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
    write(`可用 profile：${profiles.join("、") || "（无，请检查 .env 中 AIAGENT_LLM_* 配置）"}\n`);
    return;
  }
  const chosen = resolveActiveModelFromEnv(arg);
  if (!chosen) {
    // 无效 profile：报错并保持当前模型不变。
    write(
      `未知或未配置的 profile："${arg}"（可用：${listAvailableModelProfiles().join("、") || "无"}），保持当前模型不变。\n`,
    );
    return;
  }
  ctx.setModel(chosen);
  write(`已切换模型：${chosen.model.id}（profile: ${chosen.model.provider}），对后续 run 生效。\n`);
}

/**
 * /compact：立即对当前会话跑一次会话级压缩并打印前后 token。
 *
 * @param ctx 会话命令上下文。
 */
export async function compactNow(ctx: SessionCommandContext): Promise<void> {
  const model = ctx.getModel();
  if (ctx.history.length === 0) {
    write("当前会话没有历史消息，无需压缩。\n");
    return;
  }
  // C4 数据安全：tail 恢复时 history 只是后缀，必须先补全再压缩 / 落盘。
  // 补载失败则取消本次压缩，避免用尾部（或尾部压缩结果）覆盖磁盘上的更早消息。
  try {
    if (ctx.ensureFullHistory) {
      await ctx.ensureFullHistory();
    } else if (!(await ensureFullHistory(ctx.store, ctx.getSessionId(), ctx.history))) {
      throw new Error("完整历史补载失败");
    }
  } catch (error) {
    write(
      `已取消压缩：未能补载完整历史，落盘会覆盖更早消息（${
        error instanceof Error ? error.message : String(error)
      }）。\n`,
    );
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
    `已压缩：${result.tokensBefore} → ${result.tokensAfter} token / ${result.messageCountBefore} 条 → ${result.messages.length} 条\n`,
  );
  // 压缩结果立即落盘，避免下一次 run 前进程退出丢失摘要。
  await persistSession(ctx.store, ctx.getSessionId(), ctx.history, {
    model: model.model,
    summarizer: ctx.setup.summarizer,
    title: ctx.getTitle(),
    workspaceRoot: ctx.setup.cwd,
    usage: ctx.tracker,
  });
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
    const metas = await ctx.store.list();
    if (metas.length === 0) {
      write("暂无历史会话。\n");
      return;
    }
    write("最近会话：\n");
    for (const meta of metas.slice(0, 10)) {
      const time = new Date(meta.updatedAt).toLocaleString();
      write(`  ${meta.id}  ${meta.title}  ${time}  ${meta.messageCount} 条\n`);
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

  try {
    // C4 数据安全：交互切换直接全量加载。启动 --resume 才有首帧延迟诉求；切换后随时可能
    // 继续 run 并覆盖落盘，tail 后缀会成为下一轮截断的隐患。
    const record = await ctx.store.load(trimmed);
    if (!record) {
      write(`未找到会话 "${trimmed}"，保持当前会话不变。\n`);
      return;
    }
    replaceHistory(ctx.history, record.messages);
    if (record.meta.usage) ctx.tracker.restore(record.meta.usage);
    ctx.setSessionId(record.meta.id);
    ctx.setTitle(record.meta.title === "新会话" ? undefined : record.meta.title);
    // C1：打印 presenter 的折叠/思考块状态属于会话级展示状态，切会话时一并重置，
    // 避免上个会话的条目/未收尾行泄漏到新会话。
    resetPresentation();
    // 会话级权限规则同理：旧会话的「本会话一律允许」不能带入新会话。
    ctx.onSessionSwitched?.();
    write(`已切换到会话 ${record.meta.id}（${record.messages.length} 条消息，标题：${record.meta.title}）。\n`);
  } catch (error) {
    write(
      `恢复会话失败（${error instanceof Error ? error.message : String(error)}），保持当前会话不变。\n`,
    );
  }
}

/**
 * fork 旧会话：复制消息到新 sessionId 并立即落盘，旧会话文件原样保留。
 *
 * 用量快照一并继承：fork 是同一段工作的分支，成本累计不应凭空归零；
 * 新会话的 usage 会随之后每轮 persistSession 继续增长。
 *
 * @param ctx 会话命令上下文。
 * @param targetId 被 fork 的旧会话 id。
 */
async function forkSession(ctx: SessionCommandContext, targetId: string): Promise<void> {
  try {
    const record = await ctx.store.load(targetId);
    if (!record) {
      write(`未找到会话 "${targetId}"，保持当前会话不变。\n`);
      return;
    }
    // create 自带落盘（JSONL 原子写入），消息副本与新 sessionId 一并写入磁盘。
    const created = await ctx.store.create({
      workspaceRoot: ctx.setup.cwd,
      title: record.meta.title,
      messages: record.messages,
      ...(record.meta.usage ? { usage: record.meta.usage } : {}),
    });
    replaceHistory(ctx.history, record.messages);
    // 用量归属：有快照就继承；旧会话没有 usage 时必须清零，不能把当前会话成本带进 fork。
    if (record.meta.usage) ctx.tracker.restore(record.meta.usage);
    else ctx.tracker.restore({ input: 0, output: 0, total: 0, cost: 0 });
    ctx.setSessionId(created.id);
    ctx.setTitle(created.title === "新会话" ? undefined : created.title);
    resetPresentation();
    ctx.onSessionSwitched?.();
    write(
      `已 fork 自 ${record.meta.id}，新会话 ${created.id}（${ctx.history.length} 条消息，标题：${created.title}）。\n`,
    );
  } catch (error) {
    write(
      `fork 会话失败（${error instanceof Error ? error.message : String(error)}），保持当前会话不变。\n`,
    );
  }
}

/**
 * /clear：清空上下文并进入「待创建」态（不落盘新会话）。
 *
 * 与「未发消息建会话」同源（BUG 空会话落盘）：会话落盘的唯一触发点是「首条真实 message 发送」。
 * 因此 `/clear` 只清空内存历史、重置用量，并把 sessionId 置为 pending 占位（PENDING_SESSION_ID），
 * 旧会话文件原样保留；直到下一条真实消息发送时才由 persistSession 物化新会话 id。
 * 这样 `/clear` 后直接 `/exit`（未再发消息）不会产生空会话，连续 `/clear` 也不会产生多条空会话。
 *
 * @param ctx 会话命令上下文。
 */
export async function clearSession(ctx: SessionCommandContext): Promise<void> {
  const previousId = ctx.getSessionId();
  ctx.history.length = 0;
  ctx.tracker.restore({ input: 0, output: 0, total: 0, cost: 0 });
  // C1：折叠全文缓存已删除；仍重置 presenter，清空上个会话的条目与思考块状态。
  resetPresentation();
  // 进入待创建态：不立即 store.create，避免 `/clear` 空会话落盘。首条消息才物化真实 id。
  ctx.setSessionId(PENDING_SESSION_ID);
  ctx.setTitle(undefined);
  ctx.onSessionSwitched?.();
  write(`已清空上下文并进入新会话（旧会话 ${previousId} 保留在磁盘，发送首条消息后新会话才落盘）\n`);
}

/**
 * /status：模型 / 会话 / 消息数 / 用量 / MCP / Team / 权限的一次性快照。
 *
 * Team 是否启用从 `teamToolNames` 推断：组合根只在 Team 开启时注册这些工具，
 * 因此无需再引入一个可能与实际工具表脱节的布尔字段。
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
  // tail 恢复时 history 只是后缀，直接展示长度会误导（恒为 80）；标注「已加载最近」。
  const loadedAll = ctx.isFullHistoryLoaded?.() ?? true;
  const messageLine = loadedAll
    ? `消息：${ctx.history.length} 条`
    : `消息：已加载最近 ${ctx.history.length} 条（完整历史未载入）`;

  write(`模型：${model.model.id}（profile: ${model.model.provider}）\n`);
  write(`会话：${ctx.getSessionId()} · ${ctx.getTitle() ?? "新会话"}\n`);
  write(`${messageLine}\n`);
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
 * C4：resume 后内存 history 只是尾部 n 条，因此导出必须从磁盘全量 `load` 一次，
 * 否则长会话只会导出最后 80 条。磁盘不可读时退回内存 history（至少导出当前可见内容）。
 *
 * @param ctx 会话命令上下文。
 */
export async function exportSession(ctx: SessionCommandContext): Promise<void> {
  const sessionId = ctx.getSessionId();
  let messages = ctx.history;
  let title = ctx.getTitle();
  try {
    const record = await ctx.store.load(sessionId);
    if (record) {
      messages = record.messages;
      // 内存标题优先（可能刚由首条输入固定），否则用磁盘标题。
      title = title ?? (record.meta.title === "新会话" ? undefined : record.meta.title);
    }
  } catch {
    // 全量读取失败不阻断导出：降级为当前内存 history（与改造前行为一致）。
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
