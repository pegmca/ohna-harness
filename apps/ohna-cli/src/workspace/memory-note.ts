/**
 * F-7 `#` 快速记忆：把一条用户笔记追加到工作区 `AGENTS.md` 的专用段落。
 *
 * 为什么写 AGENTS.md 而不是私有数据库：`resolveSystemPrompt` 已经通过
 * `loadProjectContext` 注入 AGENTS.md，写到用户段落就能被下一轮 / 下次会话直接看到，
 * 不需要新增存储层，也符合「项目记忆单一事实源」的既有设计。
 *
 * 边界：只改 `AGENTS.md`，不覆盖其它段落；空笔记拒绝；写入前做工作区边界与敏感路径校验。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { assertPathWithinRoot, isDeniedPath } from "@aiagent/coding";

/** 用户记忆段落的固定标题（`#` 是命令前缀，这里用括号保留可读性）。 */
export const MEMORY_SECTION_TITLE = "## 用户记忆（ohna #）";

/** 追加结果：成功返回写入路径，失败返回结构化原因（调用方负责提示用户）。 */
export type AppendMemoryResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * 追加一条用户记忆到 `AGENTS.md`。
 *
 * 段落规则：
 * - 文件不存在时先创建；
 * - 已存在 `## 用户记忆（ohna #）` 时把新条目插到该段落末尾（下一个二级标题之前）；
 * - 不存在时在文件末尾追加空行 + 标题 + 条目，绝不改写其它内容。
 *
 * @param note 用户输入 `#` 之后的内容（已 trim）。
 * @param cwd 工作区根目录。
 * @returns 写入路径或失败原因。
 */
export async function appendMemoryNote(note: string, cwd: string): Promise<AppendMemoryResult> {
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, reason: "记忆内容为空（用法：# <要记住的内容>）" };

  // 记忆条目是单行 markdown 列表项：换行会破坏段落结构，统一折叠为空格。
  const entry = `- ${trimmed.replace(/\s+/g, " ")}`;
  const absolute = path.resolve(cwd, "AGENTS.md");
  const boundary = assertPathWithinRoot(absolute, cwd);
  if (!boundary.ok) return { ok: false, reason: "AGENTS.md 超出工作区边界，已拒绝写入" };
  if (isDeniedPath(absolute)) return { ok: false, reason: "AGENTS.md 命中敏感路径策略，已拒绝写入" };

  let existing = "";
  try {
    existing = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: `读取 AGENTS.md 失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const next = insertEntry(existing, entry);
  try {
    await fs.writeFile(absolute, next, "utf8");
  } catch (error) {
    return { ok: false, reason: `写入 AGENTS.md 失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, path: absolute };
}

/**
 * 把一条记忆插入文本的「用户记忆」段落；纯函数，便于单测。
 *
 * 两个容易踩的边界：
 * - **围栏代码块内不识别标题**：示例里的 `## 用户记忆` 只是文档内容，不能被当成真实段落；
 * - **保留原文件 EOL**：CRLF 文件写回仍是 CRLF，避免整个 AGENTS.md 被编辑器显示为全文件改动。
 *
 * @param existing 现有文件内容（不存在时传空串）。
 * @param entry 已格式化的 `- ...` 条目。
 * @returns 新文件内容。
 */
export function insertEntry(existing: string, entry: string): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];

  let start = -1;
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    fence = nextFence(lines[i], fence);
    if (fence) continue;
    if (lines[i].trim() === MEMORY_SECTION_TITLE) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    // 文件末尾保留一个空行再开新段；已有内容时避免与最后一行粘连。
    const base = existing.replace(/\s+$/, "");
    return `${base ? `${base}${eol}${eol}` : ""}${MEMORY_SECTION_TITLE}${eol}${eol}${entry}${eol}`;
  }

  // 找到下一个二级标题作为段落终点；同样跳过代码块内的伪标题。
  let end = lines.length;
  fence = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    fence = nextFence(lines[i], fence);
    if (fence) continue;
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // 段落末尾的空行回退到最后一个非空行之后，避免条目与后续标题之间空行越积越多。
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, entry);
  return lines.join(eol);
}

/** 代码围栏状态：起始标记字符（` 或 ~）与长度。 */
interface Fence {
  char: string;
  length: number;
}

/**
 * 推进 Markdown 代码围栏状态。
 *
 * 规则：行首（允许缩进）的连续 3 个以上 ` 或 ~ 开启围栏；同字符且长度不短的标记关闭。
 * 围栏内的行不参与标题识别。
 *
 * @param line 当前行。
 * @param current 当前围栏状态（null 表示不在围栏内）。
 * @returns 处理该行后的围栏状态。
 */
function nextFence(line: string, current: Fence | null): Fence | null {
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!match) return current;
  const marker = match[1];
  const char = marker[0];
  if (!current) return { char, length: marker.length };
  if (char === current.char && marker.length >= current.length) return null;
  return current;
}
