import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const stylesRoot = join(process.cwd(), "src/web/styles");
const orderedImports = readFileSync(join(stylesRoot, "index.css"), "utf8")
  .split(/\r?\n/u)
  .map((line) => /^@import "\.\/([^"]+\.css)";$/u.exec(line)?.[1])
  .filter((file): file is string => Boolean(file));
const css = orderedImports
  .map((file) => readFileSync(join(stylesRoot, file), "utf8"))
  .join("\n");

describe("theme styles", () => {
  test("splits styles by feature with every module below the file-size guard", () => {
    expect(orderedImports).toEqual([
      "tokens.css",
      "base.css",
      "shell.css",
      "shared.css",
      "actions.css",
      "batches.css",
      "golden.css",
      "settings.css",
      "draft-shell.css",
      "draft-editor.css",
      "draft-table.css",
      "draft-validation.css",
      "responsive.css"
    ]);
    const files = readdirSync(stylesRoot).filter((file) => file.endsWith(".css"));
    expect(new Set(files)).toEqual(new Set(["index.css", ...orderedImports]));
    for (const file of orderedImports) {
      const lines = readFileSync(join(stylesRoot, file), "utf8").split("\n").length;
      expect(lines, `${file} should stay under 500 lines`).toBeLessThan(500);
    }
  });

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
