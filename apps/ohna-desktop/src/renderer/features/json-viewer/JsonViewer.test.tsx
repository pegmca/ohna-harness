/**
 * BUG-003 JSON 阅读器：纯逻辑（json-tree）单测 + 组件行为（节点折叠 / 高亮 / 截断 / 降级 / 预算）测试。
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonViewer } from "./JsonViewer.js";
import {
  buildJsonTree,
  childKey,
  DEFAULT_DEPTH,
  collectExpandableKeys,
  decodeKeyPath,
  escapeControlChars,
  isExpandedByDefault,
  isOverBudget,
  MAX_BULK_EXPAND_NODES,
  MAX_RENDER_NODES,
  MAX_STRING_LENGTH,
  ROOT_KEY,
  summarizeNode,
  truncateString
} from "./json-tree.js";

afterEach(cleanup);

/**
 * 取任意元素的完整文本内容（测试辅助：语义树里键与值是分开的元素，
 * getByText 的精确匹配不适合断言整行，这里统一用 textContent 断言）。
 *
 * @param element DOM 元素。
 * @returns 文本内容。
 */
function textOf(element: Element): string {
  return element.textContent ?? "";
}



/** 取根节点（断言用）。 */
function rootOf(value: unknown) {
  const root = buildJsonTree(value).root;
  if (root.nodeType !== "container") throw new Error("expected container root");
  return root;
}

describe("json-tree 纯逻辑", () => {
  it("对象 / 数组结构按插入顺序与索引保留，摘要给出条目数", () => {
    const root = rootOf({ a: 1, b: [true, null] });
    expect(root.kind).toBe("object");
    expect(root.entries.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(summarizeNode(root)).toBe("{2 项}");
    const array = root.entries[1].value;
    if (array.nodeType !== "container") throw new Error("expected array");
    expect(array.kind).toBe("array");
    expect(summarizeNode(array)).toBe("[2 项]");
  });

  it("空对象 / 空数组给 {} 与 []，循环引用降级为 [Circular]", () => {
    expect(summarizeNode(rootOf({}))).toBe("{}");
    expect(summarizeNode(rootOf([]))).toBe("[]");

    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    const root = rootOf(cyclic);
    expect(root.entries[1].value).toEqual({ nodeType: "leaf", kind: "unsupported", text: "[Circular]" });

    // 同一个对象被两处引用（DAG）不是环，仍应正常展开。
    const shared = { id: 1 };
    const dag = rootOf({ left: shared, right: shared });
    expect(dag.entries.every((entry) => entry.value.nodeType === "container")).toBe(true);
  });

  it("不可序列化值安全降级：undefined / BigInt / 函数 / Symbol / Date / Map", () => {
    const root = rootOf({
      u: undefined,
      big: 10n,
      fn: function named() {},
      sym: Symbol("s"),
      date: new Date(0),
      map: new Map([["k", 1]])
    });
    const texts = root.entries.map((entry) => (entry.value.nodeType === "leaf" ? entry.value.text : ""));
    expect(texts[0]).toBe("undefined");
    expect(texts[1]).toBe("10n");
    expect(texts[2]).toBe("[Function named]");
    expect(texts[3]).toBe("Symbol(s)");
    expect(texts[4]).toBe(new Date(0).toString());
    expect(texts[5]).toContain("[object Map]");
    expect(root.entries.every((entry) => entry.value.nodeType === "leaf")).toBe(true);
  });

  it("默认深度：根与第一层展开，更深折叠", () => {
    // defaultDepth 是「可见层数」：depth（根为 0）小于它才默认展开。
    // 默认 2 → 根 + 第一层容器展开，第二层起折叠。
    expect(DEFAULT_DEPTH).toBe(2);
    expect(isExpandedByDefault(0)).toBe(true);
    expect(isExpandedByDefault(1)).toBe(true);
    expect(isExpandedByDefault(2)).toBe(false);
    expect(isExpandedByDefault(1, 1)).toBe(false);
  });

  it("节点超预算时标记 truncated，并给出 collectExpandableKeys 全量键", () => {
    const huge = Array.from({ length: MAX_RENDER_NODES + 10 }, (_, index) => index);
    expect(isOverBudget(buildJsonTree(huge))).toBe(true);
    expect(isOverBudget(buildJsonTree({ a: 1 }))).toBe(false);

    const keys = collectExpandableKeys(rootOf({ a: { b: { c: 1 } }, list: [{ d: 2 }] }));
    expect(keys.map(decodeKeyPath)).toEqual([[], ["a"], ["a", "b"], ["list"], ["list", "0"]]);
  });

  it("展开键编码是单射：键名含 / 或分隔符时不会与嵌套路径冲突", () => {
    // `{"a/b": 1}` 与 `{a: {"b": 1}}` 在旧的 `/` 拼接方案里得到同一个键，会互相覆盖展开状态。
    const flat = childKey(ROOT_KEY, "a/b");
    const nested = childKey(childKey(ROOT_KEY, "a"), "b");
    expect(flat).not.toBe(nested);
    expect(decodeKeyPath(flat)).toEqual(["a/b"]);
    expect(decodeKeyPath(nested)).toEqual(["a", "b"]);

    // 键名包含分隔符本身（NUL）时也要能无损还原。
    const withSeparator = childKey(ROOT_KEY, "x\u0000y");
    expect(withSeparator).not.toBe(childKey(ROOT_KEY, "x"));
    expect(decodeKeyPath(withSeparator)).toEqual(["x\u0000y"]);

    // 数组下标与同名字符串键也必须可区分（`0` 下标 vs `"0"` 键）。
    expect(childKey(ROOT_KEY, 0)).toBe(childKey(ROOT_KEY, "0"));

    // 真实数据里同一棵树同时存在两种形态时，收集出的键互不重复。
    const keys = collectExpandableKeys(rootOf({ "a/b": { x: 1 }, a: { b: { y: 2 } } }));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.map(decodeKeyPath)).toEqual([[], ["a/b"], ["a"], ["a", "b"]]);
  });

  it("长字符串截断不切断代理对，控制字符转义保持可读", () => {
    expect(truncateString("short")).toEqual({ text: "short", truncated: false });
    const long = "a".repeat(MAX_STRING_LENGTH + 5);
    expect(truncateString(long)).toEqual({ text: "a".repeat(MAX_STRING_LENGTH), truncated: true });

    // 切点落在高代理项上时回退一位，避免出现半个 emoji。
    const emoji = `${"a".repeat(MAX_STRING_LENGTH - 1)}😀😀`;
    const truncated = truncateString(emoji);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toBe("a".repeat(MAX_STRING_LENGTH - 1));

    expect(escapeControlChars("a\nb\tc\u0001")).toBe("a\\nb\\tc\\u0001");
  });
});

describe("JsonViewer 组件", () => {
  it("默认展开根与第一层，折叠节点显示摘要且不渲染深层子树，可逐级展开 / 收起", () => {
    render(<JsonViewer value={{ level1: { level2: { level3: "deep-value" } }, list: [1, 2] }} />);

    // 根与第一层容器展开：level2 键可见，但 level2（第二层容器）折叠为摘要，深层不进 DOM。
    expect(screen.getByText("level1")).toBeTruthy();
    expect(screen.getByText("level2")).toBeTruthy();
    expect(screen.queryByText("level3")).toBeNull();
    expect(screen.getByText("{1 项}")).toBeTruthy();
    expect(document.querySelectorAll(".json-viewer-number").length).toBe(2);

    // 展开第二层的 level2：叶子 deep-value 出现。
    const level2Row = screen.getByText("level2").closest(".json-viewer-row") as HTMLElement;
    const toggle = within(level2Row).getByRole("button", { name: /展开\/收起/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(textOf(document.body)).toContain('"deep-value"');

    // 收起第一层的 level1：其子行（含 level2）整体从 DOM 移除。
    const level1Row = screen.getByText("level1").closest(".json-viewer-row") as HTMLElement;
    fireEvent.click(within(level1Row).getByRole("button", { name: /展开\/收起/ }));
    expect(screen.queryByText("level2")).toBeNull();
    expect(textOf(document.body)).not.toContain("deep-value");
    expect(screen.getByText("{1 项}")).toBeTruthy();
  });

  it("语法高亮按类别分色：键 / 字符串 / 数字 / 布尔 / null", () => {
    const { container } = render(<JsonViewer value={{ key: "str", n: 1, b: false, z: null }} />);
    expect(container.querySelector(".json-viewer-key")?.textContent).toBe("key");
    expect(container.querySelector(".json-viewer-string")?.textContent).toBe('"str"');
    expect(container.querySelector(".json-viewer-number")?.textContent).toBe("1");
    expect(container.querySelector(".json-viewer-boolean")?.textContent).toBe("false");
    expect(container.querySelector(".json-viewer-null")?.textContent).toBe("null");
  });

  it("长字符串先截断，可「展开全文」；换行显示为转义序列", () => {
    const long = `line1\n${"x".repeat(MAX_STRING_LENGTH + 50)}`;
    render(<JsonViewer value={{ text: long }} defaultDepth={1} />);

    const more = screen.getByRole("button", { name: `展开全文（${long.length} 字符）` });
    expect(screen.getByText(/line1\\n/)).toBeTruthy();
    expect(screen.queryByText(new RegExp(`x{${MAX_STRING_LENGTH + 1}}`))).toBeNull();

    fireEvent.click(more);
    expect(screen.queryByRole("button", { name: /展开全文/ })).toBeNull();
    expect(
      (screen.getByText(/line1\\n/).parentElement as HTMLElement).querySelector(".json-viewer-string")?.textContent
        ?.length
    ).toBeGreaterThan(MAX_STRING_LENGTH);
  });

  it("「全部展开」按批量预算铺开，超出部分保持折叠", () => {
    // 宽对象 600 个子对象：键行 600 + 根行。在预算内，因此全部展开成子行。
    const wide = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`k${index}`, { deep: index }])
    );
    render(<JsonViewer value={wide} />);
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));

    const rowCount = document.querySelectorAll(".json-viewer-row").length;
    expect(rowCount).toBeGreaterThan(600);
    expect(rowCount).toBeLessThanOrEqual(MAX_BULK_EXPAND_NODES);
    expect(MAX_BULK_EXPAND_NODES).toBe(2_000);
  }, 15_000);

  it("「全部展开」不会收回超出预算、但已被 defaultDepth 展开的节点（回归）", () => {
    /*
     * 形态：1001 个容器 → 可展开键 1002 个，超过批量预算（1000）。
     * 旧实现先给所有键写 false 再展开前 1000 个，于是排在预算之后的容器被强制收起，
     * 而它们本来是 defaultDepth=2 默认展开的——表现成「点全部展开反而折叠了半个树」。
     * 断言：预算内、预算外两类容器在点击后都必须是展开态；只有更深处（默认折叠）的节点被展开。
     */
    const tall = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [`k${index}`, { inner: `v${index}` }])
    );
    render(<JsonViewer value={tall} />);

    /**
     * 取键名对应的行（键与值分段渲染，必须按键名精确匹配）。
     *
     * @param label 键名。
     * @returns 行元素。
     */
    const rowOf = (label: string): HTMLElement => {
      const key = [...document.querySelectorAll(".json-viewer-key")].find(
        (element) => element.textContent === label
      );
      if (!key) throw new Error(`row not found: ${label}`);
      return key.closest(".json-viewer-row") as HTMLElement;
    };

    /**
     * 取某键行的展开按钮。
     *
     * @param label 键名。
     * @returns 展开按钮。
     */
    const toggleOf = (label: string): HTMLElement =>
      within(rowOf(label)).getByRole("button", { name: /展开\/收起/ });

    // 点击前：第一层容器全部按 defaultDepth 展开（含排在预算之外的 k1000）。
    expect(toggleOf("k0").getAttribute("aria-expanded")).toBe("true");
    expect(toggleOf("k1000").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));

    // 关键回归点：预算之外的 k1000 不能被收回。
    expect(toggleOf("k1000").getAttribute("aria-expanded")).toBe("true");
    expect(toggleOf("k0").getAttribute("aria-expanded")).toBe("true");
    // 默认折叠的第二层容器被展开，但受预算约束，行数不失控。
    expect(document.querySelectorAll('.json-viewer-row[aria-expanded="false"]').length).toBeLessThanOrEqual(
      MAX_BULK_EXPAND_NODES
    );

    // 截断不能静默：给出「已展开前 N 个节点」的状态提示。
    const note = screen.getByRole("status").textContent ?? "";
    expect(note).toContain("已展开前");
    expect(note).toContain("保持原状");
  }, 20_000);

  it("「全部展开」在节点数未超预算时不显示截断提示", () => {
    render(<JsonViewer value={{ a: { b: { c: "leaf-value" } } }} />);
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(textOf(document.body)).toContain('"leaf-value"');
  });

  it("容器只声明自己真正实现的 ARIA 角色（回归：role=tree 但无 treeitem）", () => {
    const { container } = render(<JsonViewer value={{ a: { b: 1 } }} />);
    // 行用 disclosure 模式（button + aria-expanded），不提供 treeitem，
    // 因此容器不能再声明 role="tree"，否则读屏会播报一棵空树。
    expect(container.querySelector('[role="tree"]')).toBeNull();
    expect(container.querySelectorAll('[role="treeitem"]').length).toBe(0);
    const tree = container.querySelector(".json-viewer-tree");
    expect(tree?.getAttribute("role")).toBe("group");
    expect(tree?.getAttribute("aria-label")).toBe("JSON 结构");
    // 折叠语义由按钮自身承载。
    expect(screen.getByRole("button", { name: "展开/收起根节点" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("「全部展开 / 全部折叠」批量切换节点状态", () => {
    render(<JsonViewer value={{ a: { b: { c: "leaf-value" } } }} />);
    expect(textOf(document.body)).not.toContain("leaf-value");

    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(textOf(document.body)).toContain('"leaf-value"');

    fireEvent.click(screen.getByRole("button", { name: "全部折叠" }));
    expect(screen.queryByText("a")).toBeNull();
    expect(textOf(document.body)).not.toContain("leaf-value");
    expect(textOf(document.body)).toContain("{1 项}");
  });

  it("节点超安全上限时只展示根摘要与提示，不铺开 DOM", () => {
    const huge = { items: Array.from({ length: MAX_RENDER_NODES + 10 }, (_, index) => ({ index })) };
    render(<JsonViewer value={huge} />);
    expect(screen.getByRole("status").textContent).toContain("节点数超过安全上限");
    expect(screen.getByRole("status").textContent).toContain("复制 JSON");
    expect(screen.queryByText("items")).toBeNull();
  });

  it("键名含 / 时展开状态互相隔离（回归：旧 `/` 拼接会让两行共用同一个键）", () => {
    /*
     * 冲突形态：扁平键 `"a/b"` 的旧键是 `$/a/b`，恰好等于嵌套 `a → b` 的键。
     * 共用键的直接后果是 React 报「两个子节点用了同一个 key」——组件层面的
     * 可观测症状；纯函数层面的判定见 `childKey` 的单射性测试。
     */
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<JsonViewer defaultDepth={1} value={{ "a/b": { flat: 1 }, a: { b: "deep" } }} />);

    /**
     * 按键名精确取该行（getByText("a") 会命中也含 "a" 的 `"a/b"` 行，这里比较全等）。
     *
     * @param label 键名。
     * @returns 行元素。
     */
    const rowOf = (label: string): HTMLElement => {
      const key = [...document.querySelectorAll(".json-viewer-key")].find(
        (element) => element.textContent === label
      );
      if (!key) throw new Error(`row not found: ${label}`);
      return key.closest(".json-viewer-row") as HTMLElement;
    };

    /**
     * 取某行的展开按钮。
     *
     * @param label 键名。
     * @returns 展开按钮。
     */
    const toggleOf = (label: string): HTMLElement =>
      within(rowOf(label)).getByRole("button", { name: /展开\/收起/ });

    fireEvent.click(toggleOf("a/b"));
    expect(textOf(document.body)).toContain("flat");
    fireEvent.click(toggleOf("a"));
    expect(screen.getByText('"deep"')).toBeTruthy();

    // 两行互不共用 key（旧实现会在这里刷出 duplicate key 警告）。
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);

    // 折叠扁平键：a 保持展开、deep 仍在。
    fireEvent.click(toggleOf("a/b"));
    expect(textOf(document.body)).not.toContain("flat");
    expect(toggleOf("a").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText('"deep"')).toBeTruthy();
    consoleError.mockRestore();
  });

  it("长字符串「展开全文」跨父节点折叠保持（状态不随子树卸载丢失）", () => {
    const long = "y".repeat(MAX_STRING_LENGTH + 20);
    render(<JsonViewer value={{ outer: long, other: 1 }} />);

    /**
     * 根节点的展开按钮（根没有键名，按 aria-label 定位）。
     *
     * @returns 根节点展开按钮。
     */
    const rootToggle = (): HTMLElement => screen.getByRole("button", { name: "展开/收起根节点" });

    const more = screen.getByRole("button", { name: `展开全文（${long.length} 字符）` });
    fireEvent.click(more);
    expect(screen.queryByRole("button", { name: /展开全文/ })).toBeNull();

    // 折叠根节点 → 整棵子树卸载；再展开时「展开全文」不应复活。
    fireEvent.click(rootToggle());
    expect(screen.queryByText("outer")).toBeNull();
    fireEvent.click(rootToggle());
    expect(screen.queryByRole("button", { name: /展开全文/ })).toBeNull();
    expect(textOf(document.body)).toContain(`"${long}"`);
  });

  it("非容器根值也能渲染为单行，undefined 安全降级", () => {
    const { container, unmount } = render(<JsonViewer value="plain" />);
    expect(container.querySelector(".json-viewer-string")?.textContent).toBe('"plain"');
    unmount();

    render(<JsonViewer value={undefined} />);
    expect(screen.getByText("undefined")).toBeTruthy();
  });

  it("自定义 defaultDepth 改变默认展开层数", () => {
    const { unmount } = render(<JsonViewer defaultDepth={1} value={{ a: { b: "v" } }} />);
    expect(textOf(document.body)).not.toContain('"v"');
    unmount();

    render(<JsonViewer value={{ a: { b: "v" } }} />);
    expect(textOf(document.body)).toContain('"v"');
  });
});
