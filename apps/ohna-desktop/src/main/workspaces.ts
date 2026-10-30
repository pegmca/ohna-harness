/**
 * 原生工作区授权（spec §6.1 / §6.2）：弹出系统目录选择对话框，把选中的绝对根目录
 * canonicalize 成稳定 `workspaceId`（路径哈希），再登记到 runtime。
 *
 * 绝对根目录只存在于 main 与 runtime（spec §6）；renderer 仅拿到 `workspaceId` 与展示用
 * `displayPath`，不得凭 ID 反推授权凭据。同一 canonical 路径在 dataDir 生命周期内 id 稳定。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dialog, type BrowserWindow } from "electron";
import type { WorkspaceDescriptorDto } from "@aiagent/types";

const execFileAsync = promisify(execFile);

/**
 * 把绝对根目录归一为一个稳定、无冲突的 workspaceId。
 *
 * 采用规范路径（去尾随分隔符）的短哈希 + 末段目录名，便于人读与冲突规避。仅用于授权表键，
 * 不作为任何安全凭据；真正校验发生在 runtime 的授权反查。
 *
 * @param root canonical 绝对路径。
 * @returns 稳定 workspaceId。
 */
export function deriveWorkspaceId(root: string): string {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  const slug = normalized.split("/").filter(Boolean).pop() ?? "root";
  return `ws-${slug}-${hash}`;
}

/** 目录选择对话框的返回。 */
export interface PickResult {
  descriptor: WorkspaceDescriptorDto;
}

/**
 * 弹出原生目录选择对话框并登记工作区。
 *
 * 选中后：canonicalize 路径 → 派生 workspaceId → 经 `register` 回调登记到 runtime →
 * 返回 `WorkspaceDescriptorDto`。用户取消则返回 null（不登记、不报错）。
 *
 * @param parentWindow 作为对话框父窗口的 BrowserWindow（可空）。
 * @param register 登记到 runtime 的回调（调用方负责调用 createOhnaRuntime().registerWorkspace）。
 * @returns 已授权工作区描述符，或用户取消时 null。
 */
export async function pickWorkspace(
  parentWindow: BrowserWindow | null,
  register: (workspaceId: string, workspaceRoot: string) => Promise<WorkspaceDescriptorDto>
): Promise<WorkspaceDescriptorDto | null> {
  // showOpenDialog 的父窗口重载不接受 undefined；按是否提供父窗口分流调用。
  const result =
    parentWindow !== null
      ? await dialog.showOpenDialog(parentWindow, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const workspaceRoot = result.filePaths[0];
  const workspaceId = deriveWorkspaceId(workspaceRoot);
  // 登记主路径：runtime 内部再 realpath 校验目录仍存在（spec §6.2）。
  return register(workspaceId, workspaceRoot);
}

/**
 * 读取工作区当前 Git 分支。
 *
 * 只执行固定的只读命令 `git rev-parse --abbrev-ref HEAD`，不拼接用户输入；非 Git
 * 目录、git 缺失或 detached HEAD 无法给出分支名时返回 null，由 UI 隐藏该信息。
 *
 * @param workspaceRoot 已授权的 canonical 工作区根。
 * @returns 分支名，非 Git / 读取失败返回 null。
 */
export async function readGitBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 2_000 }
    );
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}
