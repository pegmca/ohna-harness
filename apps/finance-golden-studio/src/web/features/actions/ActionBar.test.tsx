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
        actions={[{ action: "generate", label: "Generate eval set" }]}
        client={{ runAction }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Generate eval set" }));

    expect(screen.getByRole("dialog", { name: "Generate eval set?" })).toBeInTheDocument();
    expect(runAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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
        actions={[{ action: "validate", label: "Validate authors" }]}
        client={{ runAction }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Validate authors" }));
    fireEvent.click(screen.getByRole("button", { name: "Run validation" }));

    expect(await screen.findByText("Running validation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running validation" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Running validation" })).toHaveLength(1);

    resolveAction?.(actionResult("validate"));
    expect(await screen.findByText("Validation passed.")).toBeInTheDocument();
    expect(runAction).toHaveBeenCalledWith("validate", undefined);
  });

  test("shows a server error and allows retry", async () => {
    const runAction = vi.fn(async () => {
      throw new Error("promotion_failed: approved draft is invalid");
    });
    render(
      <ActionBar
        actions={[{ action: "promote", label: "Promote approved" }]}
        client={{ runAction }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Promote approved" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm promotion" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "promotion_failed: approved draft is invalid"
    );
    expect(screen.getByRole("button", { name: "Promote approved" })).toBeEnabled();
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  });
});
