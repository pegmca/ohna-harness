import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LottiePlayer } from "./LottiePlayer";

interface TestAnimation {
  shapes: Array<{
    ty: string;
    c: {
      a: number;
      k: number[];
    };
  }>;
}

interface TestLottieConfig {
  animationData: TestAnimation;
}

const loadAnimation = vi.fn((_config: TestLottieConfig) => ({ destroy: vi.fn() }));

vi.mock("lottie-web/build/player/lottie_light", () => ({
  default: { loadAnimation }
}));

const animation: TestAnimation = {
  shapes: [
    { ty: "fl", c: { a: 0, k: [0.988, 0.533, 0.227, 1] } },
    { ty: "st", c: { a: 0, k: [0.537, 0.843, 0.718, 1] } }
  ]
};

beforeEach(() => {
  loadAnimation.mockClear();
  document.documentElement.style.setProperty("--md-color-primary", "#89d7b7");
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--md-color-primary");
});

describe("LottiePlayer 配色", () => {
  it("默认按主题强调色统一着色", async () => {
    render(<LottiePlayer animationData={animation} />);

    await waitFor(() => expect(loadAnimation).toHaveBeenCalledOnce());
    const config = loadAnimation.mock.calls[0][0] as { animationData: typeof animation };
    expect(config.animationData.shapes.map((shape) => shape.c.k)).toEqual([
      [137 / 255, 215 / 255, 183 / 255, 1],
      [137 / 255, 215 / 255, 183 / 255, 1]
    ]);
    expect(animation.shapes[0].c.k).toEqual([0.988, 0.533, 0.227, 1]);
  });

  it("preserveOriginalColors 保留多色动画原始配色", async () => {
    render(<LottiePlayer animationData={animation} preserveOriginalColors />);

    await waitFor(() => expect(loadAnimation).toHaveBeenCalledOnce());
    const config = loadAnimation.mock.calls[0][0] as { animationData: typeof animation };
    expect(config.animationData.shapes.map((shape) => shape.c.k)).toEqual([
      [0.988, 0.533, 0.227, 1],
      [0.537, 0.843, 0.718, 1]
    ]);
  });
});
