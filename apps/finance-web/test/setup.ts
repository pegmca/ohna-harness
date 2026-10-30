import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// 当前 jsdom 构建不提供 Storage；为主题与字号偏好补一个内存实现。
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

// 主题“跟随系统”依赖 matchMedia；测试环境固定浅色。
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

afterEach(() => {
  globalThis.localStorage?.clear();
  document.documentElement.style.fontSize = "";
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.fontScale;
});
