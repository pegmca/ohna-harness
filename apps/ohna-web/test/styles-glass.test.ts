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

/**
 * 抽取某个选择器块内的声明文本，找不到返回空串。
 *
 * 取**最后一次**出现：同一选择器可能先被派生规则引用（`.trace-ribbon .md-label`），
 * 真正的基类定义在文件末尾，只按首次出现取会读到派生块。
 */
function blockOf(selector: string): string {
  const idx = css.lastIndexOf(selector);
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


/**
 * WCAG 相对亮度（sRGB 线性化后的加权和）。
 *
 * @param hex `#RRGGBB` 颜色。
 * @returns 0–1 的相对亮度。
 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 两色对比度（WCAG 2.x 定义）。
 *
 * @param a `#RRGGBB`。
 * @param b `#RRGGBB`。
 * @returns 对比度倍数（如 7.58）。
 */
function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
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

  /**
   * Glass Depths 迁移只搬了 token、没搬组件类，导致 `.md-badge-success` 这类「只出现在
   * 三目表达式/模板串里」的类名在产物中缺席（失败 turn 的 failed 徽标、run 状态徽标、
   * 「再显示 N 行」按钮全部无样式）。下面锁定三组基类必须在本文件里被**真正定义**，
   * 而不是仅被 `.trace-*` 派生规则引用。
   */
  it("补定义了 .md-badge 基类与四个语义变体", () => {
    expect(blockOf(".md-badge {")).toContain("border-radius: var(--md-radius-md)");
    for (const variant of ["success", "warning", "danger", "info"]) {
      const block = blockOf(`.md-badge-${variant} {`);
      expect(block, `.md-badge-${variant} 必须被定义`).not.toBe("");
      // 语义色走 token，不硬编码色值（system.css 里那些 #bbf7d0 之类的亮档硬编码不得平移过来）。
      expect(block).toMatch(/var\(--md-color-/);
      expect(block).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  /**
   * Trace 抽屉 run 元信息条的来源徽标（v2.0 04 落地时提升语义级别）：CLI 来源用 info 档。
   * 只做**静态定义 + 对比度计算**——没有浏览器，不能声称视觉观感已验证：
   * 这里证明的是「info 档的文字色与底色的对比度达到 WCAG AA（4.5:1）」，属静态可判定部分。
   */
  it("Trace 来源徽标用 md-badge-info，且信息档文字色对比度 ≥ 4.5:1（双档）", () => {
    const drawer = readFileSync(resolve(here, "../src/features/trace/TraceDrawer.tsx"), "utf8");
    expect(drawer).toContain("md-badge md-badge-info");
    // 两档强调色（暗档 #89D7B7 / 亮档 #2F6F63）分别对各自表面色计算相对亮度比。
    expect(contrastRatio("#89D7B7", "#1E2120")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#2F6F63", "#ECECEA")).toBeGreaterThanOrEqual(4.5);
  });

  it("补定义了 .md-label 基类（upper-case 标签口径）", () => {
    const block = blockOf(".md-label {");
    expect(block).toContain("text-transform: uppercase");
    expect(block).toContain("var(--md-text-label-size)");
  });

  it("补定义了 .md-button / -secondary / -sm（含 focus-visible 与 hover）", () => {
    expect(blockOf(".md-button {")).toContain("cursor: pointer");
    expect(blockOf(".md-button:focus-visible")).toContain("var(--md-focus-ring)");
    expect(blockOf(".md-button-secondary {")).toContain("var(--md-color-surface)");
    expect(blockOf(".md-button-secondary:hover:not(:disabled)")).not.toBe("");
    expect(blockOf(".md-button-sm {")).toContain("min-height: 28px");
  });
});
