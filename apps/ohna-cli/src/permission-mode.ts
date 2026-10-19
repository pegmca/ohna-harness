/**
 * CLI 权限模式（Shift+Tab 循环）的纯函数。
 *
 * 单独成文件的原因：`repl.ts` 依赖 TUI / readline 等运行时，直接从这里导入会让
 * 模式循环难以单测；把「预设顺序 / 名称解析 / 状态文案」收敛成无副作用函数后，
 * Shift+Tab 与 `/permissions mode` 共用同一套语义。
 */
import type { PermissionPreset, PermissionRule } from "@aiagent/agent";

/** Shift+Tab 的循环顺序（bypass 不参与：它只由 --yes 初始化，循环一次后回到 default）。 */
export const PERMISSION_PRESET_CYCLE: readonly PermissionPreset[] = ["default", "acceptEdits", "plan"];

/** 预设的中文说明（`/permissions` 展示用）。 */
export const PERMISSION_PRESET_DESCRIPTIONS: Record<PermissionPreset, string> = {
  default: "写文件 / 执行命令前询问",
  acceptEdits: "自动放行 write/edit，执行命令仍询问",
  plan: "拒绝所有写操作，且不注册 mutating 工具",
  bypass: "全部放行（--yes）",
};

/**
 * 计算 Shift+Tab 的下一个模式：default → acceptEdits → plan → default。
 *
 * bypass 不在循环内：从 bypass 按一次 Shift+Tab 回到 default（显式退出全放行）。
 *
 * @param current 当前预设。
 * @returns 下一个预设。
 */
export function nextPermissionPreset(current: PermissionPreset): PermissionPreset {
  const index = PERMISSION_PRESET_CYCLE.indexOf(current);
  if (index === -1) return "default";
  return PERMISSION_PRESET_CYCLE[(index + 1) % PERMISSION_PRESET_CYCLE.length];
}

/**
 * 解析预设名（大小写不敏感），供 `/permissions mode <name>` 使用。
 *
 * @param text 用户输入。
 * @returns 合法预设；非法返回 null。
 */
export function parsePermissionPreset(text: string): PermissionPreset | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "default") return "default";
  if (normalized === "acceptedits" || normalized === "accept-edits") return "acceptEdits";
  if (normalized === "plan") return "plan";
  if (normalized === "bypass") return "bypass";
  return null;
}

/**
 * 渲染 `/permissions` 的当前状态（模式 + 会话规则 + 用法）。
 *
 * @param preset 当前预设。
 * @param rules 会话记住的规则。
 * @returns 多行文本（末尾不带换行，调用方负责 `write`）。
 */
export function formatPermissionStatus(
  preset: PermissionPreset,
  rules: readonly PermissionRule[],
): string {
  const lines = [
    `当前权限模式：${preset}（${PERMISSION_PRESET_DESCRIPTIONS[preset]}）`,
    "会话规则：",
  ];
  if (rules.length === 0) {
    lines.push("  无");
  } else {
    for (const rule of rules) {
      lines.push(`  - ${rule.toolName}${rule.target ? `：${rule.target}` : "（全部）"}`);
    }
  }
  lines.push(
    "用法：Shift+Tab 循环模式；/permissions mode <default|acceptEdits|plan|bypass>；/permissions clear 清空会话规则。",
  );
  return lines.join("\n");
}
