import type { ApiResult, IdentityMeDto } from "@aiagent/types";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

interface IdentityContextValue {
  /** 后台校验完成前为 undefined；保存了上次身份快照时可直接展示。 */
  identity: IdentityMeDto | undefined;
  refresh(): Promise<void>;
}

const IdentityContext = createContext<IdentityContextValue | undefined>(
  undefined,
);
const IDENTITY_SNAPSHOT_KEY = "immersive.identitySnapshot";

/**
 * 立即渲染应用并在后台恢复 session；没有 session 时才计算浏览器指纹并创建 userId。
 * 上次成功身份只用于首屏占位，不授予权限；校验失败会换成可重试错误门。
 *
 * @param props 子组件。
 * @returns 身份就绪后的应用，或明确的加载/失败状态。
 */
export function IdentityProvider(props: { children: ReactNode }) {
  const [identity, setIdentity] = useState<IdentityMeDto | undefined>(() =>
    readIdentitySnapshot(),
  );
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void initializeIdentity().then(
      (value) => {
        if (active) {
          setIdentity(value);
          setError(undefined);
        }
      },
      (caught) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : "无法识别当前浏览器。",
          );
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <main className="identity-gate">
        <section className="identity-gate-card">
          <p className="md-label">Immersive Identity</p>
          <h1>浏览器身份初始化失败</h1>
          <p>{error}</p>
          <button
            className="primary-action"
            onClick={() => window.location.reload()}
            type="button"
          >
            重试
          </button>
        </section>
      </main>
    );
  }
  return (
    <IdentityContext.Provider
      value={{
        identity,
        async refresh() {
          const next = await fetchIdentity();
          setIdentity(next);
        },
      }}
    >
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
  if (!value)
    throw new Error("useIdentity must be used inside IdentityProvider.");
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

  const { default: FingerprintJS } = await import(
    "@fingerprintjs/fingerprintjs"
  );
  const agent = await FingerprintJS.load();
  const result = await agent.get();
  const response = await fetch("/api/identity/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      visitorId: result.visitorId,
      fingerprintVersion: "fingerprintjs-v5",
    }),
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
  if (!response.ok)
    throw new Error("身份 session 已失效，请刷新页面重新识别。");
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
  writeIdentitySnapshot(value.data);
  return value.data;
}

/**
 * 读取上次成功识别身份的本地快照，仅用于消除刷新时的全屏身份闪屏。
 * 快照不作为权限来源：服务端仍会在后台重新校验 HttpOnly session。
 *
 * @returns 身份快照或 undefined。
 */
function readIdentitySnapshot(): IdentityMeDto | undefined {
  try {
    const raw = window.localStorage.getItem(IDENTITY_SNAPSHOT_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<IdentityMeDto>;
    if (
      typeof value.userId !== "string" ||
      typeof value.createdAt !== "string" ||
      !value.qqBot
    )
      return undefined;
    return value as IdentityMeDto;
  } catch {
    return undefined;
  }
}

/**
 * 保存非敏感身份快照，供下一次刷新首屏复用。
 *
 * @param identity 服务端确认的身份。
 * @returns void。
 */
function writeIdentitySnapshot(identity: IdentityMeDto): void {
  try {
    window.localStorage.setItem(
      IDENTITY_SNAPSHOT_KEY,
      JSON.stringify(identity),
    );
  } catch {
    // 隐私模式或存储配额不足时仍可正常使用；下一次刷新退回后台校验。
  }
}
