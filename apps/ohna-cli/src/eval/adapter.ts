/**
 * ohna 编码 Agent 评测适配器（v2.0 评测体系 Step 4，领域自治方案 §3.4 / ohna-eval-adapter 工作项）。
 *
 * 本模块把「评测执行后端」与「模型驱动」装配为可注入的两类边界：
 *
 * 1) **工具副作用 mock（确定性）**：用 `createCodingToolRegistry(cwd)` 拿到真实工具数组后，
 *    map 替换每个工具的 `execute`，保留 `name`/`parameters`/`effect` 不变，把副作用收敛为
 *    「写真实临时工作区文件 / 返回固定结果」。这是 §3.1 允许的「mock 工具副作用」——
 *    指标由确定性文件后果 + 权限记录判定，不依赖模型生成质量。
 *
 * 2) **离线确定性 streamFn 替身（控制流驱动）**：仅 integration 档 / 单测使用。它**不是生产
 *    mock 模型打分**，而是「测试用的确定性 provider 替身」——按 case 的 `expectedToolCalls`
 *    发出工具调用序列，驱动 agentLoop 走完控制流（让模型依次选择 read/edit/write/bash 等工具），
 *    以便断言「控制流与权限通道」。生产 live 档必须使用真实 provider（见 run.ts）。
 *
 * 边界声明（写进注释以明确 §3.1 修订）：
 * - 离线 streamFn **不进入指标打分**：toolSelectionCorrectness 的实际轨迹由 agentLoop 的
 *   AgentEvent 流经 app eval 域投影（见 run.ts），与「模型选了哪些工具」一致；
 * - 文件改动 / 权限 / 轮效指标由「确定性文件后果 + 权限记录 + 轮数计数」判定，与模型输出无关。
 *
 * 本文件零 `@aiagent/eval` 依赖，仅 import `@aiagent/coding`（运行时）/ `@aiagent/agent`
 * （权限领域模块 + StreamFn 类型）/ `@aiagent/ai`（AssistantMessage 类型）/ `import type @aiagent/eval-core`（ToolCallStep）。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createCodingToolRegistry } from "@aiagent/coding";
import { createPresetPolicy, type StreamFn, type PermissionEffect, type BeforeToolCallContext, type BeforeToolCallResult } from "@aiagent/agent";
import type { AgentTool, AgentToolResult } from "@aiagent/tools";
import type { AssistantMessageEventStream, AssistantMessage, ToolCall } from "@aiagent/ai";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import type { ToolCallStep } from "@aiagent/eval-core";
import type { OhnaEvalCase } from "./dataset.js";

/** 被 mock 工具写盘时使用的编码（UTF-8）。 */
const FILE_ENCODING = "utf8" as const;

/**
 * 原始编码工具「按名称」查找表类型。
 */
type RawToolMap = Map<string, AgentTool<any>>;

/**
 * 创建「工具副作用被 mock 的」编码工具集（确定性、可离线、落真实临时工作区）。
 *
 * 用 `createCodingToolRegistry(cwd)` 拿到原始工具数组（含 name/parameters/effect 契约），
 * 然后 map 替换 `execute` 为确定性实现：
 * - write/edit：把参数里的 path/content 真实写入 cwd 临时工作区（文件快照可被 metrics 断言）；
 * - read：从 cwd 真实读回文件内容（供 edit 链式 / 证明读通）；
 * - 其余（bash/grep/find/ls）：返回确定性字符串结果（无副作用、可复现）。
 *
 * 保留 `effect` 不变——read 类工具 effect="read" 直接放行，mutate 类进入权限策略。
 *
 * @param cwd 真实临时工作区根目录（所有写操作的作用域边界）。
 * @returns 副作用被 mock 的编码工具数组（契约字段未变）。
 */
export function createMockCodingTools(cwd: string): AgentTool<any>[] {
  const raw = createCodingToolRegistry(cwd);
  const byName = new Map<string, AgentTool<any>>(raw.map((tool) => [tool.name, tool]));

  return raw.map((tool) => {
    // 保留声明字段，仅替换 execute。
    return {
      ...tool,
      async execute(toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult<any>> {
        return mockExecute(tool.name, params, cwd, byName);
      },
    } as AgentTool<any>;
  });
}

/**
 * 单个工具的确定性副作用实现（写真实临时工作区 / 返回固定结果）。
 *
 * @param name 工具名。
 * @param params 已通过 zod 校验的参数。
 * @param cwd 工作区根目录。
 * @param rawByName 原始工具表（read 用原始实现读盘，避免重复路径逻辑）。
 * @returns 结构化工具结果。
 */
async function mockExecute(
  name: string,
  params: Record<string, unknown>,
  cwd: string,
  rawByName: RawToolMap,
): Promise<AgentToolResult<any>> {
  if (name === "write") {
    const path = String(params.path ?? "");
    const content = String(params.content ?? "");
    const full = resolve(cwd, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, FILE_ENCODING);
    return {
      content: [{ type: "text", text: `已写入 ${path}（${content.length} 字节）` }],
      details: { path, bytes: content.length },
    };
  }

  if (name === "edit") {
    const path = String(params.path ?? "");
    const oldText = String(params.oldText ?? "");
    const newText = String(params.newText ?? "");
    const full = resolve(cwd, path);
    const before = existsSync(full) ? readFileSync(full, FILE_ENCODING) : "";
    const after = before.replace(oldText, newText);
    writeFileSync(full, after, FILE_ENCODING);
    return {
      content: [{ type: "text", text: `已编辑 ${path}` }],
      details: { path, replaced: before !== after },
    };
  }

  if (name === "read") {
    // read 复用原始工具实现（它内部已做路径沙箱与截断），保证读回写入的文件与真实行为一致。
    const rawRead = rawByName.get("read");
    if (rawRead) {
      return (await rawRead.execute("eval-read", params)) as AgentToolResult<any>;
    }
    const path = String(params.path ?? "");
    const full = resolve(cwd, path);
    const content = existsSync(full) ? readFileSync(full, FILE_ENCODING) : "";
    return {
      content: [{ type: "text", text: content }],
      details: { path, exists: existsSync(full) },
    };
  }

  // 其余工具（bash/grep/find/ls）：返回确定性结果，无副作用、可离线复现。
  return {
    content: [{ type: "text", text: `[mock ${name}] 已执行（确定性结果）` }],
    details: { mocked: true, name, params },
  };
}

/**
 * 权限拒绝记录器：在权限钩子里收集「实际被拒工具名」，供 permissionCompliance 打分。
 */
export interface DenialRecorder {
  /** 被拒工具名列表（可重复，run 层去重）。 */
  denied: string[];
  /** 钩子本体：交给 AgentLoopConfig.beforeToolCall。 */
  hook: (toolName: string) => BeforeToolCallResult;
  /** 读取去重后的被拒工具集合。 */
  snapshot(): Set<string>;
}

/**
 * 创建权限拒绝记录器。
 *
 * @returns 记录器（含钩子与快照）。
 */
export function createDenialRecorder(): DenialRecorder {
  const denied: string[] = [];
  return {
    denied,
    hook(toolName: string) {
      denied.push(toolName);
      return { block: true, reason: `评测权限策略拒绝了 ${toolName}（确定性拒绝）` };
    },
    snapshot() {
      return new Set(denied);
    },
  };
}

/**
 * 构造「仅在期望拒绝集合内的 mutate 工具才被拒」的确定性裁决器。
 *
 * 非拒绝集合内的工具：read 直接放行（由 effect 层处理），mutate 也放行
 * （评测默认放开，仅对 `expectedPermissionDenials` 显式拒绝以验证拒绝通道）。
 * 这是「测试用的确定性权限裁决」，不是生产策略——生产权限由用户预设（plan/acceptEdits）决定。
 *
 * @param expectedDenials 期望被拒的工具名集合（来自 case.expectedPermissionDenials）。
 * @returns 裁决函数：(toolName, effect) => "allow" | "deny"。
 */
export function createEvalPermissionPolicy(expectedDenials: Set<string>): (toolName: string, effect: PermissionEffect) => "allow" | "deny" {
  return (toolName, effect) => {
    if (effect === "read") return "allow";
    if (expectedDenials.has(toolName)) return "deny";
    return "allow";
  };
}

/**
 * 装配评测权限闸门（确定性）：把上面的裁决器 + 拒绝记录器接到 `beforeToolCall`。
 *
 * 本评测用纯确定性拒绝钩子（不触发 ask 问询、无需宿主交互，可离线）：
 * 仅对 `expectedDenials` 中的 mutate 工具返回 block，并记录工具名。
 *
 * @param case_ 评测 case（取其 expectedPermissionDenials）。
 * @param recorder 拒绝记录器（收集实际被拒工具名）。
 * @returns 可直接赋给 AgentLoopConfig.beforeToolCall 的钩子。
 */
export function createEvalPermissionBeforeToolCall(
  case_: Pick<OhnaEvalCase, "expectedPermissionDenials">,
  recorder: DenialRecorder,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  const expected = new Set(case_.expectedPermissionDenials ?? []);
  const decide = createEvalPermissionPolicy(expected);

  return async (ctx, signal) => {
    if (signal?.aborted) {
      return { block: true, reason: "Run 已取消，操作未执行。" };
    }
    const toolName = ctx.toolCall.name;
    // read 工具直接放行（权限体系单一事实源：AgentTool.effect 为 read）。
    const effect = ctx.context.tools?.find((tool) => tool.name === toolName)?.effect ?? "mutate";
    if (effect === "read") return undefined;

    if (decide(toolName, effect) === "deny") {
      recorder.hook(toolName);
      return { block: true, reason: `评测期望拒绝 ${toolName}` };
    }
    return undefined;
  };
}

/**
 * 构造离线确定性 streamFn 替身（控制流驱动，不参与打分）。
 *
 * 实现边界（§3.1 修订，务必明确）：
 * - **仅驱动 agentLoop 走完控制流**：第 1 轮按 `expectedToolCalls` 发出工具调用序列，
 *   让 agentLoop 真实执行（mock 副作用）并投影出实际轨迹；
 * - 第 2 轮返回**无工具调用的收尾消息**（stopReason="stop"），使 agentLoop 收敛；
 * - **绝不回放固定模型输出用于打分**——指标由确定性文件后果 + 权限记录 + 轮数判定。
 *
 * 单测 / integration 档使用本替身；live 档由 run.ts 改用真实 streamSimple（缺配置报错）。
 *
 * @param case_ 评测 case（取其 expectedToolCalls 作为第 1 轮工具调用）。
 * @returns 注入 agentLoop 的 StreamFn 替身。
 */
export function createOfflineStreamFn(
  case_: Pick<OhnaEvalCase, "expectedToolCalls">,
): StreamFn {
  const planned = (case_.expectedToolCalls ?? []).map((step) => ({
    name: step.tool,
    arguments: (step.args ?? {}) as Record<string, unknown>,
  }));

  let turn = 0;

  return (_model, _context, _options) => {
    const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
    // 异步推进，模拟流式 LLM 返回。
    void Promise.resolve().then(() => {
      if (turn === 0) {
        turn += 1;
        emitToolUseTurn(stream, planned);
      } else {
        emitStopTurn(stream);
      }
    });
    return stream;
  };
}

/**
 * 在事件流上发出「带工具调用」的一轮 assistant 消息（stopReason=toolUse）。
 *
 * @param stream 事件流。
 * @param calls 工具调用计划。
 */
function emitToolUseTurn(stream: AssistantMessageEventStream, calls: Array<{ name: string; arguments: Record<string, unknown> }>): void {
  const toolCalls: ToolCall[] = calls.map((call, index) => ({
    type: "toolCall",
    id: `eval-tc-${index}`,
    name: call.name,
    arguments: call.arguments,
  }));
  const message = buildAssistantMessage(toolCalls);
  stream.push({ type: "start", partial: message });
  toolCalls.forEach((toolCall, index) => {
    stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
    stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: message });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
  });
  stream.push({ type: "done", reason: "toolUse", message });
}

/**
 * 在事件流上发出「无工具调用的收尾」消息（stopReason=stop）。
 *
 * @param stream 事件流。
 */
function emitStopTurn(stream: AssistantMessageEventStream): void {
  const message = buildAssistantMessage([]);
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
}

/**
 * 构造一条最小合法的 AssistantMessage（供离线替身复用）。
 *
 * @param toolCalls 工具调用块列表。
 * @returns 完整 AssistantMessage。
 */
function buildAssistantMessage(toolCalls: ToolCall[]): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(toolCalls.length === 0
        ? [{ type: "text", text: "任务完成。" } as const]
        : []),
      ...toolCalls,
    ],
    api: "openai-completions",
    provider: "eval-offline",
    model: "offline-deterministic",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** 为调用方重新导出：便于 run.ts 直接拿到 preset 策略工厂（如需 plan 模式对照）。 */
export { createPresetPolicy };
