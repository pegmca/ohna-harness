/**
 * 会话级权限记忆（PolicyState）的默认实现。
 *
 * 设计取舍：规则只保存在内存数组中，不做前缀匹配——
 * - 工具级规则（无 target）匹配该工具的所有调用；
 * - 目标级规则（如具体文件路径）只匹配完全相同的 target。
 *
 * 不做路径前缀匹配是刻意的：`src/` 前缀放行会让同目录新增文件自动获得授权，
 * 与「会话记住」的显式语义不符；用户可再次选择「本会话一律允许」来扩大授权。
 */
import type { PermissionRule, PolicyState } from "./types.js";

/**
 * 创建空的会话权限状态。
 *
 * @returns 可被多个 gate / 多个 run 共享的 PolicyState。
 */
export function createPolicyState(): PolicyState {
  /** 已记住的规则（插入顺序即 /permissions 展示顺序）。 */
  const rules: PermissionRule[] = [];

  return {
    allow(toolName, target) {
      const normalized = target?.trim();
      const next: PermissionRule = normalized ? { toolName, target: normalized } : { toolName };
      // 同工具同 target 只保留一条：用户重复点「本会话一律允许」不应产生重复展示。
      const exists = rules.some(
        (rule) => rule.toolName === next.toolName && rule.target === next.target,
      );
      if (!exists) rules.push(next);
    },

    isAllowed(toolName, target) {
      return rules.some((rule) => {
        if (rule.toolName !== toolName) return false;
        // 工具级规则：该工具在本会话内全部放行。
        if (rule.target === undefined) return true;
        // 目标级规则：只有完全相同的 target 才命中；调用方没给 target 时不匹配。
        return target !== undefined && rule.target === target;
      });
    },

    rules() {
      // 返回副本，避免调用方（/permissions）拿到内部数组后意外改写。
      return [...rules];
    },

    clear() {
      rules.length = 0;
    },
  };
}
