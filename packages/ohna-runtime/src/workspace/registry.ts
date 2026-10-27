/**
 * 工作区授权注册表：维护 `workspaceId → 绝对根目录` 的授权表，并负责会话 / run 到
 * 工作区的归属反查。
 *
 * 授权语义（spec §6）：绝对根目录只存在于 main 与 runtime；renderer 仅凭 `workspaceId`
 * 等业务标识操作资源，所有读 / 控 / 订阅入口都要经本注册表反查归属并校验当前授权，
 * 未授权 / 已撤销的工作区一律拒绝（fail-closed）。撤销只撤销后续执行授权，不删除历史会话。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceDescriptorDto } from "@aiagent/types";
import { type LocalSessionStore } from "../store/index.js";
import { RuntimeError } from "../errors.js";

/** 注册表持有的一项：canonical 根 + 描述符。 */
interface WorkspaceEntry {
  workspaceId: string;
  /** canonical（realpath + 去尾随分隔符）后的绝对根目录。 */
  canonicalRoot: string;
  descriptor: WorkspaceDescriptorDto;
}

/** 注册表依赖：会话存储用于反查历史会话持久化的 workspaceId。 */
export interface WorkspaceRegistryDeps {
  sessionStore?: LocalSessionStore;
}

/**
 * 把工作区根目录归一为 canonical 绝对路径：解析符号链接 + 去除尾随分隔符。
 *
 * 目录不存在（如撤销后已被删除）时退回 `path.resolve` + 归一，避免 realpath 抛错；
 * 授权注册发生在原生对话框选中之后，正常路径都存在，realpath 会解析 symlink。
 *
 * @param root 任意形式的根目录。
 * @returns canonical 绝对路径。
 */
export async function canonicalizeWorkspaceRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  try {
    const real = await fs.promises.realpath(resolved);
    return real.endsWith(path.sep) ? real.slice(0, -1) : real;
  } catch {
    return resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
  }
}

/**
 * 工作区授权注册表。
 *
 * 内存持有三项映射：`workspaceId → entry`（授权表）、`conversationId → workspaceId`
 * （run 创建时登记，单实例生命周期内有效）、`runId → workspaceId`（同上）。
 * 反查时优先内存绑定，回退到会话元数据持久化的 `workspaceId`，最终校验授权表是否含该工作区。
 */
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceEntry>();
  private readonly conversationToWorkspace = new Map<string, string>();
  private readonly runToWorkspace = new Map<string, string>();

  /**
   * @param deps 会话存储（用于反查历史会话的持久化 workspaceId）。
   */
  constructor(private readonly deps: WorkspaceRegistryDeps = {}) {}

  /**
   * 注册一个已授权工作区。
   *
   * @param workspaceId 稳定 ID（同一 dataDir 下唯一）。
   * @param workspaceRoot main 由原生对话框选中的绝对根目录。
   * @returns 工作区描述符（status=authorized）。
   */
  async register(workspaceId: string, workspaceRoot: string): Promise<WorkspaceDescriptorDto> {
    const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
    const descriptor: WorkspaceDescriptorDto = {
      workspaceId,
      displayPath: canonicalRoot,
      status: "authorized"
    };
    this.workspaces.set(workspaceId, { workspaceId, canonicalRoot, descriptor });
    return descriptor;
  }

  /**
   * 列出所有已授权工作区。
   *
   * @returns 工作区描述符数组。
   */
  async list(): Promise<WorkspaceDescriptorDto[]> {
    return [...this.workspaces.values()].map((entry) => ({ ...entry.descriptor }));
  }

  /**
   * 撤销工作区授权：只撤销后续执行授权，不删除历史会话 / 绑定记录。
   *
   * @param workspaceId 待撤销的工作区 ID。
   */
  async release(workspaceId: string): Promise<void> {
    // 只删除授权表项；conversationToWorkspace / runToWorkspace 绑定记录保留，
    // 使已绑定资源仍能反查到原工作区并命中「未授权」分支（workspace_unavailable），
    // 而非被误判为「从未绑定」（forbidden）。历史会话不被删除。
    this.workspaces.delete(workspaceId);
  }

  /**
   * 工作区当前是否授权。
   *
   * @param workspaceId 工作区 ID。
   * @returns 授权返回 true。
   */
  has(workspaceId: string): boolean {
    return this.workspaces.has(workspaceId);
  }

  /**
   * 登记会话到工作区的绑定（run 创建前由组合根调用）。
   *
   * @param conversationId 会话 id。
   * @param workspaceId 工作区 ID。
   */
  bindConversation(conversationId: string, workspaceId: string): void {
    this.conversationToWorkspace.set(conversationId, workspaceId);
  }

  /**
   * 登记 run 到工作区的绑定（createRun 内由 RunManager 调用）。
   *
   * @param runId run id。
   * @param conversationId 会话 id。
   * @param workspaceId 工作区 ID。
   */
  bindRun(runId: string, conversationId: string, workspaceId: string): void {
    this.runToWorkspace.set(runId, workspaceId);
    this.conversationToWorkspace.set(conversationId, workspaceId);
  }

  /**
   * 反查会话所属工作区，并校验授权（fail-closed）。
   *
   * @param conversationId 会话 id。
   * @returns 已授权的工作区归属。
   * @throws 未绑定 / 未授权时抛 `forbidden` 或 `workspace_unavailable`。
   */
  async resolveConversationWorkspace(conversationId: string): Promise<{ workspaceId: string; workspaceRoot: string }> {
    const workspaceId =
      this.conversationToWorkspace.get(conversationId) ??
      (await this.deps.sessionStore?.get(conversationId))?.workspaceId;
    if (!workspaceId) {
      throw new RuntimeError("forbidden", `会话 ${conversationId} 未绑定到任何已授权工作区。`);
    }
    return this.resolveAuthorized(workspaceId);
  }

  /**
   * 反查 run 所属工作区，并校验授权（fail-closed）。
   *
   * @param runId run id。
   * @returns 已授权的工作区归属。
   * @throws 未绑定 / 未授权时抛 `forbidden` 或 `workspace_unavailable`。
   */
  async resolveRunWorkspace(runId: string): Promise<{ workspaceId: string; workspaceRoot: string }> {
    const workspaceId = this.runToWorkspace.get(runId);
    if (!workspaceId) {
      throw new RuntimeError("forbidden", `run ${runId} 未绑定到任何已授权工作区。`);
    }
    return this.resolveAuthorized(workspaceId);
  }

  /**
   * 按工作区 ID 解析归属（仅当该工作区已授权）。与 `resolveConversationWorkspace` 的区别：
   * 这里不回退到会话持久化的 workspaceId，调用方已持有显式 ID（run 创建入参携带）。
   *
   * @param workspaceId 工作区 ID。
   * @returns 已授权的工作区归属；未授权返回 undefined（由调用方回退到会话反查）。
   */
  async resolveAuthorizedWorkspace(workspaceId: string): Promise<{ workspaceId: string; workspaceRoot: string } | undefined> {
    if (!this.has(workspaceId)) return undefined;
    return this.resolveAuthorized(workspaceId);
  }

  /**
   * 校验工作区已授权并返回其 canonical 根。
   *
   * @param workspaceId 工作区 ID。
   * @returns 工作区归属。
   * @throws 未授权时抛 `workspace_unavailable`。
   */
  private resolveAuthorized(workspaceId: string): { workspaceId: string; workspaceRoot: string } {
    const entry = this.workspaces.get(workspaceId);
    if (!entry) {
      throw new RuntimeError("workspace_unavailable", `工作区 ${workspaceId} 未授权或已被撤销。`);
    }
    return { workspaceId, workspaceRoot: entry.canonicalRoot };
  }
}
