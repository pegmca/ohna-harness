/**
 * 项目上下文装配（M1 第 4 条的一部分）。
 *
 * 为什么要有这一层：coding 模式下模型需要知道「这个仓库的规矩和可执行动作」，
 * 但不可能每轮都 agent 自己去 ls / read AGENTS.md。这里一次性把四类事实拼成中文 markdown：
 * 项目约定、设计规范、可跑脚本、git 状态，再由 CLI 注入系统提示词。
 *
 * 设计取舍：全部读取都是「尽力而为」——文件缺失或 git 不可用都静默降级，
 * 不把环境差异变成工具错误；每段独立截断，避免任何一个巨大文件撑爆上下文。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { truncateHead } from "../support/truncate.js";

const execFileAsync = promisify(execFile);

/** AGENTS.md / DESIGN.md 每段的最大字节数（超出用 truncateHead 截断并标注）。 */
const MAX_SECTION_BYTES = 8 * 1024;

/** git status 输出参与上下文的最大行数。 */
const MAX_GIT_LINES = 20;

/** 参与上下文装配的项目约定文件。 */
const CONTEXT_FILES: Array<{ title: string; fileName: string }> = [
  { title: "项目约定（AGENTS.md）", fileName: "AGENTS.md" },
  { title: "设计规范（DESIGN.md）", fileName: "DESIGN.md" },
];

/**
 * 读取单个文件内容并在必要时截断；文件不存在或不可读时返回 null。
 *
 * @param absolutePath 文件绝对路径。
 * @returns 截断后的文本内容，不可用时为 null。
 */
async function readCappedSection(absolutePath: string): Promise<string | null> {
  try {
    const raw = await readFile(absolutePath, "utf-8");
    const { content, truncated } = truncateHead(raw, { maxBytes: MAX_SECTION_BYTES, maxLines: Number.MAX_SAFE_INTEGER });
    return truncated ? content + "\n\n> （该文件过长，已按字节上限截断）" : content;
  } catch {
    return null;
  }
}

/**
 * 读取 git 分支与改动摘要；仓库不可用或 git 缺失时返回 null。
 *
 * @param cwd 工作区根目录。
 * @returns 分支名与改动行数摘要，不可用时为 null。
 */
async function readGitSummary(cwd: string): Promise<{ branch: string; changes: string[] } | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd,
      timeout: 5_000,
      maxBuffer: 1024 * 64,
    });
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return null;
    }
    const branchLine = lines[0].replace(/^##\s+/, "").trim();
    return { branch: branchLine, changes: lines.slice(1, MAX_GIT_LINES + 1) };
  } catch {
    return null;
  }
}

/**
 * 读取 package.json 的 scripts 段落，转成可读列表。
 *
 * @param cwd 工作区根目录。
 * @returns 脚本名与命令的列表；文件缺失或无 scripts 时为空数组。
 */
async function readPackageScripts(cwd: string): Promise<Array<{ name: string; command: string }>> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    return Object.entries(parsed.scripts ?? {}).map(([name, command]) => ({ name, command }));
  } catch {
    return [];
  }
}

/**
 * 装配项目上下文：把项目约定、设计规范、可跑脚本与 git 状态拼成中文 markdown。
 * 每一部分都独立降级，任一部分失败不影响其余内容。
 *
 * @param cwd 工作区根目录。
 * @returns 供系统提示词注入的中文 markdown 文本。
 */
export async function loadProjectContext(cwd: string): Promise<string> {
  const sections: string[] = ["# 项目上下文", "", "- 工作区根目录：" + cwd];

  const git = await readGitSummary(cwd);
  if (git) {
    sections.push("- Git 分支：" + git.branch);
    sections.push("- 未提交改动：" + (git.changes.length === 0 ? "无" : git.changes.length + " 处（已省略明细）"));
  } else {
    sections.push("- Git：不可用或非 git 仓库");
  }

  for (const file of CONTEXT_FILES) {
    const content = await readCappedSection(join(cwd, file.fileName));
    if (!content) {
      continue;
    }
    sections.push("", "## " + file.title, "", content.trim());
  }

  const scripts = await readPackageScripts(cwd);
  if (scripts.length > 0) {
    sections.push("", "## 可用脚本（package.json）", "");
    for (const script of scripts) {
      sections.push("- " + script.name + "：" + script.command);
    }
  }

  return sections.join("\n") + "\n";
}
