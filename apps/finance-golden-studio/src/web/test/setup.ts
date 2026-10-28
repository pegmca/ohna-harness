import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * 每个测试结束后卸载 React 树，避免路由与列表断言互相污染。
 */
afterEach(() => {
  cleanup();
});
