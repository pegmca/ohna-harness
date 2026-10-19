/**
 * 权限预设与策略组合。
 *
 * 预设语义（对齐 Claude Code 的 Shift+Tab 循环）：
 * - `default`：所有 mutate → ask；
 * - `acceptEdits`：write / edit → allow，其余 mutate（如 bash）→ ask；
 * - `plan`：所有 mutate → deny（零询问，装配层还会过滤掉 mutating 工具）；
 * - `bypass`：全部 allow（对齐 `--yes` / serve `--auto-approve`）。
 *
 * `composePolicy` 用于「用户规则叠加预设」：任一策略 deny 即 deny，否则任一 allow 即
 * allow，均无则取第一条 ask。deny 优先保证用户显式拒绝 / plan 模式不会被后续策略放宽。
 */
import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionPreset,
  PermissionRequest,
} from "./types.js";

/** 摘要中命令 / 路径的最大展示长度，避免超长参数刷屏（宿主仍可再格式化）。 */
const SUMMARY_LIMIT = 120;

/**
 * 把工具调用渲染成一句可读摘要（工具名 + 路径 / 命令）。
 *
 * 这是策略层的通用摘要，不感知工作区根目录；CLI 会用自己的 cwd 相对路径格式化，
 * serve 仍复用其既有 `summarizeToolCall`（保持前端卡片文案稳定）。
 *
 * @param request 权限请求。
 * @returns 一行摘要文本。
 */
export function summarizePermissionRequest(request: PermissionRequest): string {
  const record = isRecord(request.args) ? request.args : {};
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (request.toolName === "bash" || command) {
    return `${request.toolName} 执行命令：${truncate(command || shortJson(request.args))}`;
  }
  const target = typeof record.path === "string" && record.path.trim() ? record.path.trim() : request.target;
  if (target) return `${request.toolName} 操作文件：${truncate(target)}`;
  return `${request.toolName} 操作`;
}

/**
 * 创建预设策略。
 *
 * @param preset 预设名。
 * @returns 纯策略对象；所有输入（含会话记忆）都由调用方传入。
 */
export function createPresetPolicy(preset: PermissionPreset): PermissionPolicy {
  return {
    decide(request, state) {
      // 只读工具永远放行；plan 只约束 mutation（读文件是安全的探索行为）。
      if (request.effect === "read") return { outcome: "allow" };
      if (preset === "bypass") return { outcome: "allow" };
      if (preset === "plan") {
        return {
          outcome: "deny",
          reason: `当前为 plan 模式，已拒绝 ${request.toolName} 的写操作（未执行）。`,
        };
      }

      // 会话记忆优先于预设：用户显式点过「本会话一律允许」就不再重复打扰。
      if (state.isAllowed(request.toolName, request.target)) return { outcome: "allow" };

      // acceptEdits 的语义是「自动放行写文件类工具」，但当前 effect 只有 read/mutate
      // 两种粒度，无法区分 write/edit 与 bash；因此这里按工具名白名单近似。
      // 取舍：不为此引入第三类 effect（会把分类法复杂化），代价是新增编辑型工具
      // 必须同步这份名单，否则会退回 ask。该已知限制记录在 。
      if (preset === "acceptEdits" && (request.toolName === "write" || request.toolName === "edit")) {
        return { outcome: "allow" };
      }

      return { outcome: "ask", summary: summarizePermissionRequest(request) };
    },
  };
}

/**
 * 组合多条策略：deny 优先，allow 次之，均无则取第一条 ask。
 *
 * @param policies 按优先级排列的策略（顺序只影响 ask 摘要的选择）。
 * @returns 组合后的策略。
 */
export function composePolicy(...policies: PermissionPolicy[]): PermissionPolicy {
  return {
    decide(request, state) {
      let allowed = false;
      let ask: Extract<PermissionDecision, { outcome: "ask" }> | undefined;

      for (const policy of policies) {
        const decision = policy.decide(request, state);
        // deny 拥有最高优先级：一旦出现就直接返回，不再看后续 allow。
        if (decision.outcome === "deny") return decision;
        if (decision.outcome === "allow") allowed = true;
        else if (!ask) ask = decision;
      }

      if (allowed) return { outcome: "allow" };
      return ask ?? { outcome: "ask", summary: summarizePermissionRequest(request) };
    },
  };
}

/**
 * 截断超长摘要。
 *
 * @param text 原始文本。
 * @returns 不超过 SUMMARY_LIMIT 的文本。
 */
function truncate(text: string): string {
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}

/**
 * 紧凑 JSON 兜底（参数形状意外时仍给出可读信息）。
 *
 * @param value 任意值。
 * @returns 紧凑字符串。
 */
function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 类型守卫：判断值是否为非数组对象。
 *
 * @param value 任意值。
 * @returns true 表示对象记录。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
