import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// 设置页读取构建期注入的版本号（vite define）；vitest 不做 vite 构建替换，这里给出测试常量。
(globalThis as unknown as Record<string, unknown>).__OHNA_WEB_VERSION__ = "0.1.0-test";

// 该 jsdom 构建不提供 Storage（window.localStorage 为 undefined）：补一个内存实现，
// 让主题/字号这类纯本地偏好在测试里也能被「持久化 + 挂载前恢复」。
if (!globalThis.localStorage) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    }
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

// 该 jsdom 构建也不提供 matchMedia：主题「跟随系统」需要它，补一个恒定浅色实现。
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    } as MediaQueryList)
  });
}

// 用例之间重置本地偏好与根节点样式，避免主题/字号串味。
afterEach(() => {
  globalThis.localStorage?.clear();
  document.documentElement.style.fontSize = "";
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.fontScale;
});
