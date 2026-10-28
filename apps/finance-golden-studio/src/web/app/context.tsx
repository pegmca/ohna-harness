import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { GoldenStudioClient } from "../shared/api/client.js";

/** 应用上下文中的客户端注入点。 */
interface AppContextValue {
  client: GoldenStudioClient;
}

/** 应用级 React 上下文。 */
const AppContext = createContext<AppContextValue | undefined>(undefined);

/**
 * 创建应用上下文提供者的 props。
 *
 * @param client 注入的数据客户端。
 * @returns context Provider 组件。
 */
export function AppProvider({
  children,
  client
}: {
  children: ReactNode;
  client: GoldenStudioClient;
}) {
  return <AppContext.Provider value={{ client }}>{children}</AppContext.Provider>;
}

/**
 * 读取注入的数据客户端。
 *
 * @returns Golden Studio 数据客户端。
 * @throws {Error} 未包裹 AppProvider 时抛出。
 */
export function useApiClient(): GoldenStudioClient {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApiClient must be used inside AppProvider.");
  return context.client;
}

/**
 * 读取可选的注入客户端，供支持组件测试直传 client 的页面使用。
 *
 * @returns 上下文客户端；未包裹 AppProvider 时为 undefined。
 */
export function useOptionalApiClient(): GoldenStudioClient | undefined {
  return useContext(AppContext)?.client;
}
