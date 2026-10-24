/**
 * 单次模式（D-A4/D-A10）：经进程内 serve 创建一次 run 并等待终态后返回。
 *
 * 单一形态下「单次」与「REPL」走同一条执行线（`server.createRun` + 订阅终态）：
 * 传了 `--resume` 时直接复用该 serve 会话（旧版本地 JSONL id 给出结构化错误）；
 * 否则首条消息物化新会话。结果由 serve 持久化，进程退出后 `--resume <id>` 可续写。
 *
 * 非 TTY（管道 / `--prompt`）语义由调用方保证：stdin 已 EOF，进程在终态后正常退出 0；
 * provider 错误由事件渲染打印，并以非零退出码让脚本/CI 感知。
 */
import type { ActiveModel } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import { createToolConfirmGate, type ConfirmHook } from "../permission/confirm.js";
import { createPermissionSession } from "../permission/permission-session.js";
import { expandFileReferencesDetailed } from "../workspace/file-reference.js";
import { getConversationMeta, isLegacySessionId, LegacySessionIdError, resolveDataDir } from "../session/serve-session.js";
import { write, type UsageTracker } from "../ui/render.js";
import { renderFrame, TERMINAL_RUN_STATUSES } from "../cli/web-entry.js";
import type { OhnaServer } from "@aiagent/serve";
import type { RunSetup } from "../runtime/turn.js";

/**
 * 单次运行：发起一次 serve run 并等待终态。
 *
 * @param prompt 用户问题。
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param setup 本轮的模式配置。
 * @param tracker 会话级用量累计器。
 * @param server 进程内 serve 句柄（执行权唯一归属）。
 * @param dataDir 数据目录（与 serve 实例一致）。
 * @param onGateReady 权限闸门就绪回调（K3：回填 team controller 的可变 gate 引用）。
 */
export async function runSingleTurn(
  prompt: string,
  active: ActiveModel,
  tools: AgentTool<any>[],
  setup: RunSetup,
  tracker: UsageTracker,
  server: OhnaServer,
  dataDir: string,
  onGateReady?: (gate: ConfirmHook) => void,
): Promise<void> {
  const resolvedDataDir = resolveDataDir(dataDir);
  const permissionSession = createPermissionSession({ autoApprove: setup.autoApprove, tools });
  const beforeToolCall = createToolConfirmGate({
    autoApprove: setup.autoApprove,
    cwd: setup.cwd,
    state: permissionSession.state,
    getPreset: () => permissionSession.preset(),
  });
  onGateReady?.(beforeToolCall);

  // 解析目标会话：--resume 复用既有 serve 会话；否则首条消息物化新会话。
  let sessionId = setup.resumeId ?? "";
  if (setup.resumeId && isLegacySessionId(setup.resumeId)) {
    throw new LegacySessionIdError(setup.resumeId);
  }
  if (sessionId) {
    const meta = await getConversationMeta(resolvedDataDir, sessionId);
    if (!meta) {
      process.stderr.write(`未找到会话 "${sessionId}"，已按新会话执行。\n`);
      sessionId = "";
    }
  }
  if (!sessionId) {
    const fresh = await server.createConversation(prompt.replace(/\s+/g, " ").slice(0, 40));
    sessionId = fresh.conversationId;
  }

  const { content, warnings } = await expandFileReferencesDetailed(prompt, setup.cwd);
  for (const warning of warnings) write(`⚠️ ${warning}\n`);

  const { accepted } = await server.createRun({
    conversationId: sessionId,
    message: typeof content === "string" ? content : JSON.stringify(content),
    mode: "auto",
    source: "cli",
    ...(setup.maxTurns !== undefined ? { maxTurns: setup.maxTurns } : {}),
    ...(setup.deadlineMs !== undefined ? { deadlineMs: setup.deadlineMs } : {}),
    ...(setup.maxCost !== undefined ? { maxCost: setup.maxCost } : {}),
  });

  const renderOptions = { workspaceRoot: setup.cwd };
  const terminalRunIds = new Set<string>();
  let resolveFinish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinish = resolve;
  });
  const unsubscribe = server.subscribeRun(accepted.runId, (event) => {
    if (event.type === "run_status") {
      const status = (event.payload as { status?: string } | null)?.status;
      if (status && TERMINAL_RUN_STATUSES.has(status)) terminalRunIds.add(event.runId);
    }
    renderFrame(event, tracker, renderOptions, { runId: accepted.runId }, () => resolveFinish(), undefined);
  });
  if (terminalRunIds.has(accepted.runId)) resolveFinish();
  await finished;
  unsubscribe();

  write(`\n会话已保留：${sessionId}（可用 --resume ${sessionId} 续写）\n`);
}
