import assert from "node:assert/strict";

const baseUrl = process.env.AIAGENT_SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
let sessionCookie;

const pageResponse = await fetch(baseUrl);
assert.equal(pageResponse.ok, true, `Web entry returned ${pageResponse.status}.`);
assert.match(await pageResponse.text(), /<div id="root"><\/div>/);

/** 请求 JSON，并把非 2xx 转换成包含响应正文的可操作错误。 */
async function requestJson(path, init) {
  const headers = new Headers(init?.headers);
  if (sessionCookie) headers.set("cookie", sessionCookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = await response.json();
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** 读取 SSE 事件流直到结束，返回已解析的事件数组。 */
async function readSseEvents(path) {
  const headers = new Headers();
  if (sessionCookie) headers.set("cookie", sessionCookie);
  const response = await fetch(`${baseUrl}${path}`, { headers });
  assert.equal(response.status, 200, `${path} SSE 状态 ${response.status}`);
  const text = await response.text();
  const events = [];
  let current = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("id: ")) {
      current.id = line.slice(4);
    } else if (line.startsWith("event: ")) {
      current.event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      current.data = line.slice(6);
    } else if (line.trim() === "" && current.data !== undefined) {
      try {
        events.push({ ...current, ...JSON.parse(current.data) });
      } catch {
        events.push(current);
      }
      current = {};
    }
  }
  return events;
}

/** 创建异步 Run 并轮询其终态快照。 */
async function runResearch(request) {
  const accepted = await requestJson("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await requestJson(accepted.data.snapshotUrl);
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.data.status)) return snapshot.data;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Compose Run did not reach a terminal state.");
}

const health = await requestJson("/health");
assert.equal(health.ok, true);
const ready = await requestJson("/ready");
assert.equal(ready.ok, true);

const bootstrapResponse = await fetch(`${baseUrl}/api/identity/bootstrap`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ visitorId: "compose-smoke-visitor", fingerprintVersion: "smoke-test" })
});
assert.equal(bootstrapResponse.ok, true);
sessionCookie = bootstrapResponse.headers.getSetCookie()[0]?.split(";")[0];
assert.ok(sessionCookie, "Identity bootstrap did not set a session cookie.");

// Run 的 conversationId 必须是服务端持久化会话（runs.conversation_id 外键到 conversations），
// 与 Web 真实路径一致：先建会话再提交 Run。
async function createConversation(title) {
  const created = await requestJson("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  });
  return created.data.conversationId;
}

const chat = await runResearch({
  message: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
  conversationId: await createConversation("Compose Smoke Chat"),
  mode: "auto",
  source: "composer"
});
assert.equal(chat.status, "completed", `chat run 终态=${chat.status}`);

const report = await runResearch({
  message: "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF。",
  conversationId: await createConversation("Compose Smoke Report"),
  mode: "auto",
  source: "composer"
});
assert.equal(report.status, "completed", `report run 终态=${report.status}`);

// 从 report run 的 SSE 事件中提取 pdf_export 下载链接与 artifactId。
const events = await readSseEvents(`/api/runs/${report.runId}/events?afterSequence=0`);
const pdfExportEvent = events.find((event) => event.type === "pdf_export" && event.payload?.status === "ready");
assert.ok(pdfExportEvent, "report run 中缺少 pdf_export ready 事件");
const downloadUrl = pdfExportEvent.payload.downloadUrl;
assert.ok(downloadUrl, "pdf_export 事件缺少 downloadUrl");
const artifactIdMatch = downloadUrl.match(/\/api\/report-artifacts\/([^/]+)\/download/);
assert.ok(artifactIdMatch, `无法从下载链接解析 artifactId: ${downloadUrl}`);
const artifactId = artifactIdMatch[1];

const artifact = await requestJson(`/api/report-artifacts/${artifactId}`);
assert.equal(artifact.data.artifactId, artifactId);
assert.equal(artifact.data.status, "pdf_ready", `artifact 状态=${artifact.data.status}`);

const download = await fetch(`${baseUrl}/api/report-artifacts/${artifactId}/download`, { headers: { cookie: sessionCookie } });
assert.equal(download.status, 200, `PDF 下载状态 ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
assert(bytes.length > 100 && bytes.subarray(0, 5).toString() === "%PDF-", "下载内容不是有效 PDF");

console.log("Compose smoke passed: web, readiness, chat, natural-language report, and PDF-ready artifact.");
