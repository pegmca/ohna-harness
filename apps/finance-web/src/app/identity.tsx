import type { ApiResult, IdentityMeDto } from "@aiagent/types";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

interface IdentityContextValue {
  identity: IdentityMeDto;
  refresh(): Promise<void>;
}

const IdentityContext = createContext<IdentityContextValue | undefined>(undefined);
let initialization: Promise<IdentityMeDto> | undefined;

/**
 * 在应用渲染前恢复 session；没有 session 时才计算浏览器指纹并创建 userId。
 *
 * @param props 子组件。
 * @returns 身份就绪后的应用，或明确的加载/失败状态。
 */
export function IdentityProvider(props: { children: ReactNode }) {
  const [identity, setIdentity] = useState<IdentityMeDto>();
  const [error, setError] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    initialization ??= initializeIdentity();
    void initialization.then(
      (value) => { if (active) { setIdentity(value); setError(undefined); } },
      (caught) => {
        initialization = undefined;
        if (active) setError(caught instanceof Error ? caught.message : "无法识别当前浏览器。");
      }
    );
    return () => { active = false; };
  }, [retryKey]);

  if (error) {
    return (
      <main className="identity-gate">
        <section className="identity-gate-card">
          <p className="md-label">Immersive Identity</p>
          <h1>浏览器身份初始化失败</h1>
          <p>{error}</p>
          <button className="primary-action" onClick={() => setRetryKey((value) => value + 1)} type="button">重试</button>
        </section>
      </main>
    );
  }
  if (!identity) {
    return (
      <main className="identity-gate" aria-busy="true">
        <section className="identity-gate-card"><p className="md-label">Immersive</p><h1>正在识别当前浏览器</h1><p>正在恢复或创建稳定 userId。</p></section>
      </main>
    );
  }

  return (
    <IdentityContext.Provider value={{
      identity,
      async refresh() {
        const next = await fetchIdentity();
        setIdentity(next);
      }
    }}>
      {props.children}
    </IdentityContext.Provider>
  );
}

/**
 * 读取当前身份上下文。
 *
 * @returns 已初始化的身份与刷新方法。
 */
export function useIdentity(): IdentityContextValue {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("useIdentity must be used inside IdentityProvider.");
  return value;
}

/**
 * 优先使用 HttpOnly session，401 时才运行 FingerprintJS。
 *
 * @returns 当前身份。
 */
async function initializeIdentity(): Promise<IdentityMeDto> {
  const existing = await fetch("/api/identity/me");
  if (existing.ok) return parseIdentity(await existing.json());
  if (existing.status !== 401) throw new Error("身份服务暂时不可用。");

  const { default: FingerprintJS } = await import("@fingerprintjs/fingerprintjs");
  const agent = await FingerprintJS.load();
  const result = await agent.get();
  const response = await fetch("/api/identity/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitorId: result.visitorId, fingerprintVersion: "fingerprintjs-v5" })
  });
  if (!response.ok) throw new Error("无法根据浏览器指纹创建 userId。");
  return parseIdentity(await response.json());
}

/**
 * 从服务端重新读取 QQ 绑定状态。
 *
 * @returns 最新身份。
 */
async function fetchIdentity(): Promise<IdentityMeDto> {
  const response = await fetch("/api/identity/me");
  if (!response.ok) throw new Error("身份 session 已失效，请刷新页面重新识别。");
  return parseIdentity(await response.json());
}

/**
 * 收窄统一 ApiResult。
 *
 * @param value API JSON。
 * @returns 身份 DTO。
 */
function parseIdentity(value: ApiResult<IdentityMeDto>): IdentityMeDto {
  if (!value.ok) throw new Error(value.error.message);
  return value.data;
}
