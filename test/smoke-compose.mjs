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

/** 创建异步 Run 并轮询其终态快照。 */
async function runResearch(request) {
  const accepted = await requestJson("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await requestJson(accepted.data.snapshotUrl);
    if (["succeeded", "failed", "cancelled"].includes(snapshot.data.status)) return snapshot.data;
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

// Run 的 conversationId 必须是服务端持久化会话（agent_runs.conversation_id 外键到 conversations），
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
assert.equal(chat.result.intent, "tool");

const report = await runResearch({
  message: "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF。",
  conversationId: await createConversation("Compose Smoke Report"),
  mode: "auto",
  source: "composer"
});
assert.equal(report.result.intent, "report_skill");
assert.equal(report.result.reportPlan.triggerSource, "natural_language");
assert.equal(report.result.reportWorkflow.run.status, "paused");
assert.equal(report.result.reportWorkflow.artifact.status, "html_preview_only");

const artifactId = report.result.reportWorkflow.artifact.artifactId;
const artifact = await requestJson(`/api/report-artifacts/${artifactId}`);
assert.equal(artifact.data.artifactId, artifactId);
console.log("Compose smoke passed: web, readiness, chat, natural-language report, and artifact status.");
