/**
 * 阶段 3 手工冒烟脚本（一次性，不参与 CI）：新会话 → 发起 run → 查消息列表与 SSE 重放 → 确认恢复完整。
 * 前置：pnpm db:up && pnpm db:migrate，且 pnpm --filter @aiagent/finance-api dev 已在运行（mock provider）。
 *
 * 用法：node test/smoke-linear-persistence.mjs [baseUrl]
 */
const baseUrl = process.argv[2] ?? "http://127.0.0.1:3001";

/** @param {Response} response @returns {Promise<object>} 已校验 ok 的 JSON。 */
async function json(response) {
  const body = await response.json();
  if (!body.ok) throw new Error(`API error: ${JSON.stringify(body.error)}`);
  return body.data;
}

/** @param {string} path @param {object} [options] @returns {Promise<Response>} fetch 封装。 */
async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  return response;
}

const boot = await api("/api/identity/bootstrap", {
  method: "POST",
  body: JSON.stringify({ visitorId: `smoke-${Date.now()}`, fingerprintVersion: "smoke-v1" })
});
const cookie = boot.headers.get("set-cookie").split(";")[0];
console.log("✔ identity bootstrap");

const conversation = await json(await api("/api/conversations", {
  method: "POST", headers: { cookie }, body: JSON.stringify({ title: "冒烟会话" })
}));
console.log("✔ conversation created:", conversation.conversationId);

const accepted = await json(await api("/api/runs", {
  method: "POST",
  headers: { cookie },
  body: JSON.stringify({
    message: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
    conversationId: conversation.conversationId,
    mode: "auto",
    source: "composer"
  })
}));
console.log("✔ run accepted:", accepted.runId);

let snapshot;
for (let attempt = 0; attempt < 200; attempt += 1) {
  snapshot = await json(await api(`/api/runs/${accepted.runId}`, { headers: { cookie } }));
  if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log("✔ run terminal:", snapshot.status, "lastEventSequence:", snapshot.lastEventSequence);
if (snapshot.status !== "completed") throw new Error(`unexpected status: ${snapshot.status}`);

const messages = await json(await api(`/api/conversations/${conversation.conversationId}/messages`, { headers: { cookie } }));
console.log("✔ messages:", messages.items.map((m) => `${m.sequence}:${m.role}`).join(" → "));
const roles = messages.items.map((m) => m.role);
if (JSON.stringify(roles) !== JSON.stringify(["user", "assistant", "toolResult", "assistant"])) {
  throw new Error(`unexpected message roles: ${roles}`);
}

// SSE 重放：全量与游标续传一致性。
const replay = await api(`/api/runs/${accepted.runId}/events?afterSequence=0`, { headers: { cookie } });
const events = (await replay.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
console.log("✔ SSE replay events:", events.length, "first:", events[0].type, "last:", events.at(-1).type);
if (events.length !== snapshot.lastEventSequence) throw new Error("replay length != lastEventSequence");
const cursor = snapshot.lastEventSequence - 2;
const tail = await api(`/api/runs/${accepted.runId}/events?afterSequence=${cursor}`, { headers: { cookie, "last-event-id": String(cursor) } });
const tailEvents = (await tail.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
if (tailEvents.length !== 2 || tailEvents[0].sequence !== cursor + 1) throw new Error("cursor replay mismatch");
console.log("✔ SSE cursor replay ok");

// 第二轮 run：验证历史从数据库恢复（跨请求无内存依赖，重启服务亦同）。
const second = await json(await api("/api/runs", {
  method: "POST",
  headers: { cookie },
  body: JSON.stringify({ message: "第二轮：继续分析这家公司。", conversationId: conversation.conversationId, mode: "auto", source: "composer" })
}));
for (let attempt = 0; attempt < 200; attempt += 1) {
  const s = await json(await api(`/api/runs/${second.runId}`, { headers: { cookie } }));
  if (["completed", "failed", "cancelled", "interrupted"].includes(s.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const after = await json(await api(`/api/conversations/${conversation.conversationId}/messages`, { headers: { cookie } }));
console.log("✔ after 2nd run messages:", after.items.map((m) => `${m.sequence}:${m.role}`).join(" → "));
if (after.items.length <= messages.items.length) throw new Error("second run did not append messages");
console.log("SMOKE OK");
process.exit(0);
