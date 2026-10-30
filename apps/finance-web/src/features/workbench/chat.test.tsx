import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline } from "./chat";

afterEach(() => cleanup());

describe("ChatTimeline empty state", () => {
  it("renders the 144px Lottie brand canvas", () => {
    const { container } = render(
      <ChatTimeline
        compactEmpty
        conversationId="c1"
        error={undefined}
        hasMore={false}
        isLoading={false}
        isSubmitting={false}
        messages={[]}
        onLoadMore={vi.fn()}
        onOpenRunDetail={vi.fn()}
        onRetryMessage={vi.fn()}
        onUsePrompt={vi.fn()}
      />,
    );
    const player = container.querySelector<HTMLElement>(
      ".empty-brand-logo .lottie-player",
    );
    expect(player).toBeTruthy();
    expect(player?.style.width).toBe("144px");
    expect(player?.style.height).toBe("144px");
  });
});
