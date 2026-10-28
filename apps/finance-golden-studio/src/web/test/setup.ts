import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/** jsdom 不保证提供可写 localStorage，测试环境使用稳定内存实现。 */
const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, value)
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage
});

/** jsdom 不实现滚动布局；问题定位点击只验证状态，不验证真实滚动。 */
Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined
});

/**
 * 每个测试结束后卸载 React 树，避免路由与列表断言互相污染。
 */
afterEach(() => {
  cleanup();
});
