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

const chat = await requestJson("/api/agent/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "帮我查询 000001.SZ 最近一期净利润和 ROE。", reportMode: false })
});
assert.equal(chat.ok, true);
assert.equal(chat.data.intent, "tool");

const report = await requestJson("/api/agent/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF。", reportMode: false })
});
assert.equal(report.data.intent, "report_skill");
assert.equal(report.data.reportPlan.triggerSource, "natural_language");

const workflow = await requestJson("/api/report-workflows", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ plan: report.data.reportPlan, requestId: report.data.requestId, traceId: report.data.traceId })
});
assert.equal(workflow.data.run.status, "paused");
assert.equal(workflow.data.artifact.status, "html_preview_only");
assert.equal(workflow.data.artifact.pdfExport.status, "queued");

const artifact = await requestJson(`/api/report-artifacts/${workflow.data.artifact.artifactId}`);
assert.equal(artifact.data.artifactId, workflow.data.artifact.artifactId);
console.log("Compose smoke passed: web, readiness, chat, natural-language report, and artifact status.");
