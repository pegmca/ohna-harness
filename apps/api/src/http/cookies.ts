/**
 * 从 Cookie header 读取指定 cookie，避免将 cookie parser 依赖扩散到 API contract。
 *
 * @param header 原始 Cookie header。
 * @param name cookie 名称。
 * @returns 解码后的值。
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

/**
 * 创建安全 session cookie；本地 HTTP 允许非 Secure，生产环境强制 HTTPS。
 *
 * @param token 不透明 session token。
 * @param expiresAt 过期时间。
 * @returns Set-Cookie header。
 */
export function serializeSessionCookie(token: string, expiresAt: string, useSecure: boolean): string {
  const secure = useSecure ? "; Secure" : "";
  return `aiagent_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}
