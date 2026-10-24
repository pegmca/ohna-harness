/**
 * Glass Depths 视觉刷新（07 · G1/G4）的样式静态断言。
 *
 * 设计约束：本文件用 Node 文件系统读取 `src/styles.css` 文本做静态断言，
 * 避免走 vitest 的 CSS 处理管线（tailwind `@import` 在测试中会因缺少 vite 插件而报错）。
 * 这样既能校验「断开 system.css + token 自持」是否落地，又不引入任何测试期依赖。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "../src/styles.css");
const css = readFileSync(cssPath, "utf8");

/** 抽取某个选择器块内的声明文本，找不到返回空串。 */
function blockOf(selector: string): string {
  const idx = css.indexOf(selector);
  if (idx === -1) return "";
  // 从选择器后第一个 `{` 找到配对的 `}`（本文件无嵌套块，线性扫描即够）。
  const open = css.indexOf("{", idx);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

describe("Glass Depths：styles.css 自持 token 落地", () => {
  it("已断开对 system.css 的共享 import", () => {
    expect(css).not.toContain('@import "../../../system.css"');
    // 保留 tailwind 的 import。
    expect(css).toContain('@import "tailwindcss";');
  });

  it("暗档画布为中性近黑 #18191A（data-theme=\"dark\"）", () => {
    const dark = blockOf(':root,\n[data-theme="dark"]');
    expect(dark).toContain("--md-color-canvas: #18191A");
  });

  it("亮档画布为暖白 #FBFAF9（data-theme=\"light\"）", () => {
    const light = blockOf('[data-theme="light"]');
    expect(light).toContain("--md-color-canvas: #FBFAF9");
  });

  it("不残留 finance 借鉴的死 token（--md-market-up / --md-market-down）", () => {
    expect(css).not.toContain("--md-market-up");
    expect(css).not.toContain("--md-market-down");
  });

  it("补定义了 --md-shadow-lg（修复既有 3 处未定义引用）", () => {
    expect(css).toMatch(/--md-shadow-lg\s*:/);
  });
});
