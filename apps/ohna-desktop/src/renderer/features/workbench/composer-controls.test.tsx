/**
 * TC-A4-02 · 只读态 composer 禁用（docs/v1.4/06 A4 / D-A7）。
 *
 * 只读观测实例（observeOnly=true）下 composer 整体禁用：textarea 不可输入、发送按钮禁用、
 * 灵感与模型选择器禁用，并展示只读 banner，而不是让用户发送后 404（BUG-005 止血）。
 * 可交互实例（observeOnly=false / undefined）下 textarea 与发送按钮可用。
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerControls } from "./composer-controls";
import type { ModelOptionDto } from "@aiagent/types";

afterEach(() => {
  cleanup();
});

/** @returns 最小可渲染的 composer 属性（非只读态基准）。 */
function baseProps(): ComponentProps<typeof ComposerControls> {
  const models: ModelOptionDto[] = [{
    id: "mock",
    label: "Mock Agent",
    provider: "mock",
    description: "Test model",
    isDefault: true,
    capabilities: { structuredOutput: true, toolCalling: true },
    // v2.0（docs/v2.0/04 §5.6）：模型目录新增成本计量字段，mock 值按 0 下发。
    contextWindow: 128_000,
    maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }];
  return {
    error: undefined,
    input: "",
    isSubmitting: false,
    models,
    modelCatalogStatus: "ready",
    onInputChange: () => undefined,
    onRetryModels: () => undefined,
    onSelectModel: () => undefined,
    onStop: () => undefined,
    onSubmit: () => undefined,
    onUsePrompt: () => undefined,
    prompts: ["示例任务一", "示例任务二"],
    selectedModelId: "mock"
  };
}

/** @returns 带文本、模型就绪的 composer，用于验证常规可发态。 */
function interactiveProps(): ComponentProps<typeof ComposerControls> {
  return { ...baseProps(), input: "列出 src 目录结构" };
}

describe("ComposerControls 只读态", () => {
  it("observeOnly=true 时 textarea 禁用且只读 banner 可见", () => {
    render(<ComposerControls {...baseProps()} observeOnly={true} />);

    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeDisabled();

    // 只读 banner 文案必须可见，告知用户在终端启动 ohna 后才能交互。
    expect(screen.getByText(/只读观测实例/)).toBeTruthy();
    // 灵感与发送按钮同样禁用，避免「能输入但发送必 404」。
    expect(screen.getByRole("button", { name: "任务灵感" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("observeOnly=false 时 textarea 可用且发送按钮不禁用", () => {
    render(<ComposerControls {...interactiveProps()} observeOnly={false} />);

    const textarea = screen.getByRole("textbox");
    expect(textarea).not.toBeDisabled();
    expect(screen.queryByText(/只读观测实例/)).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  });

  it("observeOnly=undefined 时按常规可发态处理（不禁用）", () => {
    render(<ComposerControls {...interactiveProps()} observeOnly={undefined} />);

    const textarea = screen.getByRole("textbox");
    expect(textarea).not.toBeDisabled();
    expect(screen.queryByText(/只读观测实例/)).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  });

  it("observeOnly=true 时模型选择器禁用", () => {
    render(<ComposerControls {...baseProps()} observeOnly={true} />);
    // 模型选择器按钮展示已选模型标签（baseProps 选中的是 "Mock Agent"），禁用态不可点击。
    expect(screen.getByRole("button", { name: "Mock Agent" })).toBeDisabled();
  });
});
