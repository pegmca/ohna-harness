import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { GoldenStudioAction } from "../../shared/api/types.ts";
import { ActionBar } from "./ActionBar.tsx";

/** 构造可由 fake client 返回的动作结果。 */
function actionResult(action: GoldenStudioAction["action"], ok = true) {
  if (action === "promote") {
    return {
      action,
      result: {
        ok,
        batch: "batch-01",
        approvedCount: 2,
        promotedCount: ok ? 2 : 0,
        pendingCount: 0,
        promoted: [],
        validation: { ok, errors: [], warnings: [], keywordResults: [] }
      }
    };
  }
  if (action === "generate") {
    return {
      action,
      result: {
        ok,
        caseCount: 2,
        ragCount: 2,
        failureCount: 0,
        outputPath: "/workspace/rag-golden-v1.json",
        validation: { ok, errors: [], warnings: [], keywordResults: [] }
      }
    };
  }
  return {
    action,
    result: {
      ok,
      validation: { ok, errors: [], warnings: [], keywordResults: [] }
    }
  };
}

describe("ActionBar", () => {
  test("requires confirmation before calling a generating action", async () => {
    const runAction = vi.fn(async () => actionResult("generate"));
    render(
      <ActionBar
        actions={[{ action: "generate", label: "生成评测集" }]}
        client={{ runAction }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "生成评测集" }));

    expect(screen.getByRole("dialog", { name: "生成评测集？" })).toBeInTheDocument();
    expect(runAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(runAction).not.toHaveBeenCalled();
  });

  test("shows pending, then the authoritative success result", async () => {
    let resolveAction: ((value: ReturnType<typeof actionResult>) => void) | undefined;
    const runAction = vi.fn(
      () =>
        new Promise<ReturnType<typeof actionResult>>((resolve) => {
          resolveAction = resolve;
        })
    );
    render(
      <ActionBar
        actions={[{ action: "validate", label: "校验作者集" }]}
        client={{ runAction }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "校验作者集" }));
    fireEvent.click(screen.getByRole("button", { name: "开始校验" }));

    expect(await screen.findByText("正在校验")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在校验" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "正在校验" })).toHaveLength(1);

    resolveAction?.(actionResult("validate"));
    expect(await screen.findByText("校验通过。")).toBeInTheDocument();
    expect(runAction).toHaveBeenCalledWith("validate", undefined);
  });

  test("shows a server error and allows retry", async () => {
    const runAction = vi.fn(async () => {
      throw new Error("promotion_failed: approved draft is invalid");
    });
    render(
      <ActionBar
        actions={[{ action: "promote", label: "发布已审核草稿" }]}
        client={{ runAction }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "发布已审核草稿" }));
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "promotion_failed: approved draft is invalid"
    );
    expect(screen.getByRole("button", { name: "发布已审核草稿" })).toBeEnabled();
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  });
});
