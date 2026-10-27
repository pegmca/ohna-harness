/**
 * 渲染端测试用的 `window.ohna` preload SDK 桩（Task 13）。
 *
 * 旧测试经 `vi.mock("../../shared/api/*")` + `fetch("/api/...")` 伪造 HTTP 层；renderer 已迁移到
 * 进程内 SDK（`shared/sdk/ohna-client` 只读 `window.ohna`），不再有任何 HTTP 调用（仅 `/api/health`
 * 只读探针例外，由 settings 测试单独 stub）。本模块提供可 spy 的 SDK 对象，测试只配置对应方法
 * 的返回值即可，`ohna-client` 的薄封装逻辑仍被真实执行。
 */
import type {
  ConversationSummaryDto,
  CursorPageDto,
  LinearMessageDto,
  ModelCatalogDto,
  RunMetaDtoV2,
  RunSnapshotDtoV2,
  RunStartResultDto,
  RunStreamEventDtoV2,
  WorkspaceDescriptorDto
} from "@aiagent/types";
import { vi } from "vitest";

/** 可编程 SDK 桩：每个方法都是 vi.fn，测试可自由配置实现。 */
export interface OhnaStub {
  workspaces: {
    pick: () => Promise<WorkspaceDescriptorDto>;
    list: () => Promise<WorkspaceDescriptorDto[]>;
  };
  conversations: {
    list: (query?: { workspaceId?: string }) => Promise<ConversationSummaryDto[]>;
    create: (input: { title?: string; workspaceId: string }) => Promise<ConversationSummaryDto>;
    update: (id: string, input: { title?: string; archive?: boolean }) => Promise<ConversationSummaryDto | null>;
    listMessages: (id: string, query?: { afterSequence?: number; limit?: number }) => Promise<CursorPageDto<LinearMessageDto> | null>;
    generateTitle: (id: string, text: string) => Promise<ConversationSummaryDto | undefined>;
  };
  runs: {
    start: (request: unknown) => Promise<RunStartResultDto>;
    snapshot: (id: string) => Promise<RunSnapshotDtoV2 | null>;
    list: (id: string) => Promise<RunMetaDtoV2[]>;
    cancel: (id: string) => Promise<RunSnapshotDtoV2 | null>;
    resolveConfirmation: (runId: string, toolCallId: string, decision: "allow" | "deny") => Promise<unknown>;
  };
  events: {
    subscribeRun: (id: string, onEvent: (event: RunStreamEventDtoV2) => void) => Promise<() => void>;
    subscribeConversation: (id: string, onEvent: (event: RunStreamEventDtoV2) => void) => Promise<() => void>;
  };
  models: {
    list: () => Promise<ModelCatalogDto>;
  };
  app: {
    getHealth: () => Promise<unknown>;
  };
}

/** @returns 全新的空 SDK 桩（所有方法返回 undefined 的 vi.fn）。 */
export function createOhnaStub(): OhnaStub {
  return {
    workspaces: { pick: vi.fn(), list: vi.fn() },
    conversations: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      listMessages: vi.fn(),
      generateTitle: vi.fn()
    },
    runs: {
      start: vi.fn(),
      snapshot: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
      resolveConfirmation: vi.fn()
    },
    events: {
      subscribeRun: vi.fn(),
      subscribeConversation: vi.fn()
    },
    models: { list: vi.fn() },
    app: { getHealth: vi.fn() }
  };
}

/** 把桩挂到 `globalThis.window.ohna`，模拟 preload 注入。 @param stub 待注入的 SDK 桩。 */
export function installOhnaStub(stub: OhnaStub): void {
  (globalThis as unknown as { window: { ohna?: OhnaStub } }).window = {
    ...(globalThis as unknown as { window?: { ohna?: OhnaStub } }).window,
    ohna: stub
  };
}

/** 测试间清理：移除已注入的 SDK，避免用例互相串味。 */
export function resetOhnaStub(): void {
  delete (globalThis as unknown as { window?: { ohna?: OhnaStub } }).window?.ohna;
}
