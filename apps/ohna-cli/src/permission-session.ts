/**
 * 会话级权限会话：把「当前预设 + 会话规则 + 工具过滤 + /permissions 文案」收拢成一个对象。
 *
 * 从 repl.ts 拆出的原因：REPL 已接近单文件行数上限，而权限状态的生命周期
 * （跨轮持有、Shift+Tab 切换、plan 模式过滤工具）是内聚的一块领域逻辑；
 * 拆出后 repl 只保留「把 session 接到 TUI / slash handler」的编排。
 */
import { createPolicyState, type PermissionPreset, type PolicyState } from "@aiagent/agent";
import type { AgentTool } from "@aiagent/tools";
import {
  formatPermissionStatus,
  nextPermissionPreset,
  parsePermissionPreset,
} from "./permission-mode.js";

/** 权限会话的构造参数。 */
export interface PermissionSessionOptions {
  /** --yes：初始为 bypass（Shift+Tab 可退回 default）。 */
  autoApprove: boolean;
  /** 完整工具表（plan 模式下按 effect 过滤）。 */
  tools: readonly AgentTool<any>[];
}

/**
 * 权限会话句柄：状态 + 预设 + 工具视图 + /permissions 处理。
 */
export interface PermissionSession {
  /** 会话记忆（供闸门直接引用，跨轮共享）。 */
  readonly state: PolicyState;
  /**
   * 当前预设（闸门每次裁决时实时读取）。
   *
   * @returns 当前权限预设。
   */
  preset(): PermissionPreset;
  /**
   * Shift+Tab 循环：default → acceptEdits → plan → default。
   *
   * @returns 切换后的用户提示文案（带换行）。
   */
  cycle(): string;
  /**
   * 当前可注册给模型的工具：plan 模式过滤掉 mutating 工具（含未标注 effect 的 MCP 工具）。
   *
   * @returns 完整工具表或只读子集。
   */
  activeTools(): AgentTool<any>[];
  /**
   * 切换会话时清空会话规则（preset 保留：用户当前模式不应被切会话重置）。
   */
  reset(): void;
  /**
   * 处理 `/permissions [clear | mode <preset>]`，返回要写入终端的文本。
   *
   * @param arg 命令参数（已 trim）。
   * @returns 展示 / 操作结果文案（带换行）。
   */
  handleCommand(arg: string): string;
}

/**
 * 创建权限会话。
 *
 * @param options 自动放行开关与完整工具表。
 * @returns 跨轮复用的权限会话。
 */
export function createPermissionSession(options: PermissionSessionOptions): PermissionSession {
  const state = createPolicyState();
  const tools = [...options.tools];
  let preset: PermissionPreset = options.autoApprove ? "bypass" : "default";

  return {
    state,

    preset: () => preset,

    cycle() {
      preset = nextPermissionPreset(preset);
      return switchMessage(preset);
    },

    activeTools() {
      if (preset !== "plan") return tools;
      // 缺省 effect 视为 mutate：MCP 工具在 plan 模式下同样不注册。
      return tools.filter((tool) => (tool.effect ?? "mutate") !== "mutate");
    },

    reset() {
      state.clear();
    },

    handleCommand(arg) {
      const trimmed = arg.trim();
      if (!trimmed) return `${formatPermissionStatus(preset, state.rules())}\n`;

      const [sub, ...rest] = trimmed.split(/\s+/);
      if (sub === "clear") {
        state.clear();
        return "已清空会话权限规则。\n";
      }
      if (sub === "mode") {
        const parsed = parsePermissionPreset(rest[0] ?? "");
        if (!parsed) return "用法：/permissions mode <default|acceptEdits|plan|bypass>\n";
        preset = parsed;
        return switchMessage(preset);
      }
      return "用法：/permissions | /permissions clear | /permissions mode <preset>\n";
    },
  };
}

/**
 * 模式切换的统一回显。
 *
 * @param preset 切换后的预设。
 * @returns 用户提示文案。
 */
function switchMessage(preset: PermissionPreset): string {
  return `已切换权限模式：${preset}\n`;
}
