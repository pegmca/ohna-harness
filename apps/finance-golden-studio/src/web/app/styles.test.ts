import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/web/styles.css"), "utf8");

describe("theme styles", () => {
  test("keeps explicit dark selection ahead of the system dark fallback", () => {
    const explicitDarkIndex = css.indexOf(':root[data-theme="dark"]');
    const systemDarkIndex = css.indexOf("@media (prefers-color-scheme: dark)");

    expect(systemDarkIndex).toBeGreaterThan(-1);
    expect(systemDarkIndex).toBeGreaterThan(explicitDarkIndex);
  });

  test("maps local font size preferences to CSS variables without viewport scaling", () => {
    expect(css).toContain(':root[data-font-size="compact"]');
    expect(css).toContain(':root[data-font-size="large"]');
    expect(css).not.toMatch(/font-size:\s*[^;]*vw/);
  });
});
