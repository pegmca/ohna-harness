/**
 * 手工冒烟：带附件提问 → RAG grounding 注入 → 引用落库 + retrieval 事件。
 * 依赖本地 API（默认 127.0.0.1:3001）与 PostgreSQL。
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const API = process.env.API_BASE_URL ?? "http://127.0.0.1:3001";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://aiagent:aiagent-local@127.0.0.1:5432/aiagent";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function api(path, { method = "GET", body, cookie } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(data)}`);
  }
  return { data, setCookie };
}

function extractSessionCookie(setCookie) {
  const header = setCookie.find((h) => h.includes("aiagent_session="));
  if (!header) return undefined;
  return header.split(";")[0];
}

async function main() {
  // 1. 身份 bootstrap
  const visitorId = `smoke_${Date.now()}`;
  const { data: me, setCookie } = await api("/api/identity/bootstrap", {
    method: "POST",
    body: { visitorId, fingerprintVersion: "1" },
  });
  const cookie = extractSessionCookie(setCookie);
  assert(me.ok && cookie, "bootstrap 应返回有效 session");
  const userId = me.data.userId;
  console.log("bootstrap ok, userId:", userId);

  // 2. 创建会话
  const { data: conv } = await api("/api/conversations", {
    method: "POST",
    body: { title: "RAG grounding smoke" },
    cookie,
  });
  assert(conv.ok, "创建会话失败");
  const conversationId = conv.data.conversationId;
  console.log("conversation:", conversationId);

  // 3. 上传附件（年报片段）
  const clientAttachmentId = randomUUID();
  const content =
    "# 示例公司 2024 年度报告\n\n" +
    "2024 年度，公司实现营业收入 100 亿元，同比增长 18%。\n\n" +
    "归属于上市公司股东的净利润为 10 亿元，同比增长 25%。\n\n" +
    "扣除非经常性损益后的净利润为 9.5 亿元。\n";
  const { data: attach } = await api("/api/attachments", {
    method: "POST",
    body: {
      clientAttachmentId,
      fileName: "report.md",
      contentType: "text/markdown",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      content,
    },
    cookie,
  });
  assert(attach.ok && attach.data.documentId, "附件上传失败");
  const documentId = attach.data.documentId;
  console.log("attachment indexed, documentId:", documentId);

  // 4. 创建带附件的 run
  const clientMessageId = randomUUID();
  const { data: run } = await api("/api/runs", {
    method: "POST",
    body: {
      message: "根据附件分析净利润",
      conversationId,
      attachmentDocumentIds: [documentId],
      mode: "auto",
      source: "composer",
      clientMessageId,
    },
    cookie,
  });
  assert(run.ok, "创建 run 失败");
  const runId = run.data.runId;
  console.log("run created:", runId);

  // 5. 轮询快照直到终态
  let snapshot;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const { data: s } = await api(`/api/runs/${runId}`, { cookie });
    snapshot = s.data;
    if (["completed", "failed", "interrupted", "cancelled"].includes(snapshot.status)) break;
  }
  assert(snapshot, "run 快照为空");
  console.log("run terminal status:", snapshot.status);
  assert(snapshot.status === "completed", `run 未完成: ${snapshot.status}`);

  // 6. 读取消息列表
  const { data: messagesPage } = await api(
    `/api/conversations/${conversationId}/messages?limit=100`,
    { cookie }
  );
  assert(messagesPage.ok, "读取消息失败");
  const messages = messagesPage.data.items;
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  assert(assistantMessages.length > 0, "应存在 assistant 消息");
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const assistantMessageId = lastAssistant.messageId;
  console.log("assistant messageId:", assistantMessageId);

  // 7. 直连数据库验证 message_citations 与 run_events_v2
  const { execFileSync } = await import("node:child_process");
  const psql = (sql) => {
    const out = execFileSync("docker", [
      "exec", "aiagent-postgres-1", "psql", "-U", "aiagent", "-d", "aiagent",
      "-P", "pager=off", "-t", "-c", sql
    ], { encoding: "utf8" });
    return out.trim();
  };

  const citations = psql(
    `SELECT count(*) FROM message_citations WHERE message_id = '${assistantMessageId}'`
  );
  console.log("citation rows:", citations);
  assert(Number(citations) > 0, "assistant 消息应有关联 citation");

  const retrievalEvents = psql(
    `SELECT count(*) FROM run_events_v2 WHERE run_id = '${runId}' AND event_type = 'retrieval'`
  );
  console.log("retrieval events:", retrievalEvents);
  assert(Number(retrievalEvents) > 0, "应写入 retrieval 事件");

  const bound = psql(
    `SELECT count(*) FROM chat_attachment_uploads WHERE user_id = '${userId}' AND document_id = '${documentId}' AND bound_message_id IS NOT NULL`
  );
  console.log("attachment bound rows:", bound);
  assert(Number(bound) > 0, "附件应被绑定到用户消息");

  console.log("\n✅ RAG grounding 冒烟通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
