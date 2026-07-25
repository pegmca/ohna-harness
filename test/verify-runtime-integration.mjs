#!/usr/bin/env node
/**
 * PR-10 runtime 集成全链路验证脚本（真实 Fastify API 进程 + 真实 PostgreSQL）。
 *
 * 覆盖：identity bootstrap / conversation / run 终态、SSE 断线重连连续性、
 * 读取链路（messages/snapshot/trace）、审批决定与幂等重放、report workflow + PDF 导出与下载、
 * RAG ingest/search/citation、跨重启持久化与 stale run 恢复、跨用户越权隔离、
 * clientMessageId 并发幂等与取消竞争、pg_dump 备份恢复、PostgreSQL 故障注入（结构化错误不泄漏）、
 * SIGTERM graceful shutdown（在途 run 落库为 run_interrupted）。
 *
 * 运行方式：
 *   1. pnpm build
 *   2. AIAGENT_POSTGRES_PORT=55433 docker compose up -d postgres
 *      （本机 127.0.0.1:5432 被其他项目的容器占用，所以验证环境用 55433；
 *        若 5432 空闲可直接 pnpm db:up 并设 AIAGENT_VERIFY_PGPORT=5432）
 *   3. node test/verify-runtime-integration.mjs
 *
 * 脚本使用独立数据库 aiagent_verify（含 _restore 临时库）、独立端口 3210、
 * 独立 ARTIFACT_STORAGE_ROOT（test/.artifacts-runtime-verify，结束后自动清理），
 * 不会触碰其他库的现有数据。任一检查点 FAIL 即 exit 1。
 */
import { spawn, execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 验证专用配置：独立端口/库/存储目录，与主开发环境完全隔离。 */
const API_PORT = Number(process.env.AIAGENT_VERIFY_API_PORT ?? 3210);
const BASE = `http://127.0.0.1:${API_PORT}`;
const PG_PORT = process.env.AIAGENT_VERIFY_PGPORT ?? "55433";
const DB_NAME = "aiagent_verify";
const DB_RESTORE = "aiagent_verify_restore";
const DATABASE_URL = `postgresql://aiagent:aiagent-local@127.0.0.1:${PG_PORT}/${DB_NAME}`;
const ARTIFACT_ROOT = path.join(repoRoot, "test", ".artifacts-runtime-verify");
const API_ENTRY = path.join(repoRoot, "apps/api/dist/server.js");
const MIGRATE_ENTRY = path.join(repoRoot, "packages/database/dist/migrate.js");
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

const results = [];
/** 当前 API 子进程句柄；finally 中必须确保被杀掉。 */
let apiChild = null;

/**
 * 记录一个检查点结果并打印。
 *
 * @param {string} name 检查点名。
 * @param {() => Promise<void>} fn 检查体；抛错即 FAIL。
 */
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

/** @param {boolean} cond 条件。 @param {string} message 失败消息。 */
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** @param {number} ms 等待毫秒数。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 通过 docker compose exec 在 postgres 容器内执行 SQL，返回 stdout（-At 纯文本）。
 *
 * @param {string} db 目标数据库名。
 * @param {string} sql SQL 文本。
 * @returns {Promise<string>} stdout 去尾换行。
 */
async function psql(db, sql) {
  const { stdout } = await execFileAsync(
    "docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "aiagent", "-d", db, "-At", "-c", sql],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
  );
  return stdout.trim();
}

/**
 * 通用 JSON API 调用。
 *
 * @param {string} method HTTP 方法。
 * @param {string} url 路径。
 * @param {{cookie?: string, body?: unknown, headers?: Record<string, string>}} [options] 请求选项。
 * @returns {Promise<{status: number, json: any, text: string, headers: Headers}>}
 */
async function api(method, url, options = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE/二进制响应允许非 JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}

/**
 * 创建/恢复身份并提取 session cookie。
 *
 * @param {string} visitorId 浏览器指纹标识。
 * @returns {Promise<string>} `name=value` 形式的 cookie。
 */
async function bootstrap(visitorId) {
  const response = await api("POST", "/api/identity/bootstrap", {
    body: { visitorId, fingerprintVersion: "verify-v1" }
  });
  assert(response.status === 200, `bootstrap ${visitorId} 状态 ${response.status}: ${response.text}`);
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "bootstrap 缺少 set-cookie");
  return setCookie.split(";")[0];
}

/**
 * 轮询 run 快照直到终态。
 *
 * @param {string} runId Run 标识。
 * @param {string} cookie 会话 cookie。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<any>} 终态快照 data。
 */
async function waitTerminal(runId, cookie, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api("GET", `/api/runs/${runId}`, { cookie });
    assert(response.status === 200, `GET run ${runId} 状态 ${response.status}: ${response.text}`);
    if (TERMINAL.has(response.json.data.status)) return response.json.data;
    await sleep(150);
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到达终态`);
}

/**
 * 提交 run 并返回 accepted DTO。
 *
 * @param {string} cookie 会话 cookie。
 * @param {string} conversationId 会话标识。
 * @param {string} message 用户消息。
 * @param {string} clientMessageId 幂等键。
 * @param {{mode?: string, source?: string}} [extra] 额外字段。
 * @returns {Promise<any>} accepted data。
 */
async function submitRun(cookie, conversationId, message, clientMessageId, extra = {}) {
  const response = await api("POST", "/api/runs", {
    cookie,
    body: { message, conversationId, mode: "auto", source: "composer", clientMessageId, ...extra }
  });
  assert(response.status === 202, `POST /api/runs 状态 ${response.status}: ${response.text}`);
  return response.json.data;
}

/**
 * 读取 SSE 事件流，直到拿到终端事件或流结束；可提前在拿到若干事件后主动断开。
 *
 * @param {string} runId Run 标识。
 * @param {string} cookie 会话 cookie。
 * @param {{afterSequence?: number, abortAfter?: number, timeoutMs?: number}} [options] 读取控制。
 * @returns {Promise<any[]>} 收到的事件数组。
 */
async function readSse(runId, cookie, options = {}) {
  const controller = new AbortController();
  const url = `/api/runs/${runId}/events${options.afterSequence ? `?afterSequence=${options.afterSequence}` : ""}`;
  const response = await fetch(`${BASE}${url}`, {
    headers: { cookie, ...(options.afterSequence ? { "last-event-id": String(options.afterSequence) } : {}) },
    signal: controller.signal
  });
  assert(response.status === 200, `SSE ${url} 状态 ${response.status}`);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        events.push(JSON.parse(line.slice(6)));
        const last = events.at(-1);
        if (options.abortAfter && events.length >= options.abortAfter) {
          controller.abort();
          return events;
        }
        if (last.type === "run_result" || last.type === "run_error") {
          controller.abort();
          return events;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  return events;
}

/** 启动 API 子进程并等待 readiness。 @returns {Promise<void>} */
async function startApi() {
  if (apiChild) throw new Error("API 已在运行");
  apiChild = spawn("node", [API_ENTRY], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      DATABASE_URL,
      IDENTITY_FINGERPRINT_PEPPER: "verify-pepper",
      AIAGENT_PROVIDER_MODE: "mock",
      ARTIFACT_STORAGE_ROOT: ARTIFACT_ROOT
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  apiChild.stderr.on("data", () => {});
  apiChild.stdout.on("data", () => {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (apiChild.exitCode !== null) throw new Error(`API 进程提前退出 exitCode=${apiChild.exitCode}`);
    try {
      const response = await fetch(`${BASE}/ready`);
      if (response.status === 200) return;
    } catch { /* 尚未监听 */ }
    await sleep(250);
  }
  throw new Error("API readiness 等待超时");
}

/**
 * 停止 API 进程并等待退出。
 *
 * @param {"SIGTERM" | "SIGKILL"} [signal] 终止信号。
 * @returns {Promise<number | null>} 进程退出码。
 */
async function stopApi(signal = "SIGTERM") {
  const child = apiChild;
  if (!child) return null;
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill(signal);
  const code = await Promise.race([exited, sleep(20_000).then(() => "timeout")]);
  if (code === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
  apiChild = null;
  return code;
}

/** 若 API 未运行则启动；用于跨步骤容错（前序步骤可能杀死了进程）。 */
async function ensureApi() {
  if (!apiChild || apiChild.exitCode !== null) {
    apiChild = null;
    await startApi();
  }
}

/** 主流程：环境准备 → 10 组检查 → 汇总。 */
async function main() {
  await mkdir(ARTIFACT_ROOT, { recursive: true });

  // 独立验证库：先 drop 再 create，保证每次运行从空库开始，不触碰其他库。
  await psql("aiagent", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(async () => {
    await psql("aiagent", `DROP DATABASE IF EXISTS ${DB_NAME}`);
  });
  await psql("aiagent", `CREATE DATABASE ${DB_NAME}`);
  await execFileAsync("node", [MIGRATE_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL }
  });
  console.log(`setup: 数据库 ${DB_NAME} 已建并迁移完成，artifact root=${ARTIFACT_ROOT}`);

  await startApi();

  // ---- 共享上下文：用户 A、会话、基础 run ----
  const cookieA = await bootstrap("verify-user-a-00000001");
  const conversation = await api("POST", "/api/conversations", { cookie: cookieA, body: { title: "运行时集成验证会话" } });
  assert(conversation.status === 201, `创建会话失败 ${conversation.status}: ${conversation.text}`);
  const conversationId = conversation.json.data.conversationId;

  // 1. bootstrap → conversation → run → 终态
  let accepted1;
  await check("1. bootstrap/conversation/run 到终态 succeeded", async () => {
    accepted1 = await submitRun(cookieA, conversationId, "帮我查询 000001.SZ 最近一期净利润和 ROE。", "verify-cm-1");
    assert(accepted1.snapshotUrl === `/api/runs/${accepted1.runId}`, "snapshotUrl 契约不符");
    const snapshot = await waitTerminal(accepted1.runId, cookieA);
    assert(snapshot.status === "succeeded", `终态=${snapshot.status}`);
    assert(snapshot.events[0].type === "run_status", "首事件应为 run_status");
    assert(snapshot.events.at(-1).type === "run_result", "末事件应为 run_result");
    assert(snapshot.events.every((event, index) => event.sequence === index + 1), "事件 sequence 不连续");
  });

  // 2. SSE 断线重连：读部分流 → abort → afterSequence 重连 → 连续无重复无缺失
  await check("2. SSE abort + afterSequence 重连，sequence 连续无重复", async () => {
    const accepted = await submitRun(cookieA, conversationId, "帮我查询 000001.SZ 最近一期净利润和 ROE。", "verify-cm-sse");
    const first = await readSse(accepted.runId, cookieA, { abortAfter: 2, timeoutMs: 15_000 });
    assert(first.length >= 2, `首段只读到 ${first.length} 个事件`);
    const resumed = await readSse(accepted.runId, cookieA, { afterSequence: first.at(-1).sequence, timeoutMs: 15_000 });
    const all = [...first, ...resumed];
    const sequences = all.map((event) => event.sequence);
    assert(new Set(sequences).size === sequences.length, `重连后出现重复 sequence: ${sequences}`);
    sequences.forEach((sequence, index) => assert(sequence === index + 1, `sequence 缺失/乱序: ${sequences}`));
    assert(["run_result", "run_error"].includes(all.at(-1).type), "终态事件未到达");
    assert(all.at(-1).type === "run_result", `SSE run 未成功: ${all.at(-1).type}`);
  });

  // 3. 读取链路 + 审批 + workflow/artifact/PDF + citation
  const ctx = {};
  await check("3a. 读取链路 messages/snapshot/trace", async () => {
    const messages = await api("GET", `/api/conversations/${conversationId}/messages`, { cookie: cookieA });
    assert(messages.status === 200 && messages.json.data.items.length > 0, `messages 读取失败: ${messages.text}`);
    const snapshot = await api("GET", `/api/runs/${accepted1.runId}`, { cookie: cookieA });
    assert(snapshot.status === 200 && snapshot.json.data.status === "succeeded", "run snapshot 读取失败");
    const trace = await api("GET", `/api/traces/${accepted1.requestId}`, { cookie: cookieA });
    assert(trace.status === 200 && trace.json.data.requestId === accepted1.requestId, `trace 读取失败: ${trace.text}`);
  });

  await check("3b. 审批决定 + 同决定幂等重放", async () => {
    const accepted = await submitRun(cookieA, conversationId, "执行 SQL: SELECT * FROM metrics", "verify-cm-approval");
    const snapshot = await waitTerminal(accepted.runId, cookieA);
    const approval = snapshot.result.trace.events.find((event) => event.type === "approval" && event.status === "requested");
    assert(approval, "trace 中缺少 approval requested 事件");
    assert(typeof approval.inputDigest === "string" && approval.inputDigest.length > 0, "approval inputDigest 为空");
    const url = `/api/runs/${accepted.runId}/approvals/${approval.approvalId}/decision`;
    const decided = await api("POST", url, { cookie: cookieA, body: { decision: "approved", inputDigest: approval.inputDigest } });
    assert(decided.status === 200 && decided.json.data.decision === "approved", `决定失败: ${decided.text}`);
    const replay = await api("POST", url, { cookie: cookieA, body: { decision: "approved", inputDigest: approval.inputDigest } });
    assert(replay.status === 200 && replay.json.data.decision === "approved", `幂等重放失败: ${replay.text}`);
  });

  await check("3c. report workflow 审批 → PDF 导出 → 下载", async () => {
    const accepted = await submitRun(
      cookieA, conversationId,
      "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF。",
      "verify-cm-report", { mode: "report", source: "report_button" }
    );
    ctx.reportRunId = accepted.runId;
    const snapshot = await waitTerminal(accepted.runId, cookieA);
    const workflow = snapshot.result.reportWorkflow;
    assert(workflow, "结果缺少 reportWorkflow");
    assert(workflow.run.status === "paused", `workflow 状态=${workflow.run.status}`);
    assert(workflow.artifact.status === "html_preview_only", `artifact 状态=${workflow.artifact.status}`);
    const approvalRequest = workflow.run.approvalRequest;
    assert(typeof approvalRequest.inputDigest === "string" && approvalRequest.inputDigest.length > 0, "workflow 审批 digest 为空");
    const decided = await api("POST", `/api/runs/${accepted.runId}/approvals/${approvalRequest.approvalId}/decision`, {
      cookie: cookieA, body: { decision: "approved", inputDigest: approvalRequest.inputDigest }
    });
    assert(decided.status === 200, `workflow 审批决定失败: ${decided.text}`);
    ctx.artifactId = workflow.artifact.artifactId;
    ctx.artifactCitations = workflow.artifact.citations ?? [];
    const exported = await api("POST", `/api/report-artifacts/${ctx.artifactId}/pdf`, { cookie: cookieA });
    assert(exported.status === 200 && exported.json.data.status === "pdf_ready", `PDF 导出失败: ${exported.text}`);
    const download = await fetch(`${BASE}/api/report-artifacts/${ctx.artifactId}/download`, { headers: { cookie: cookieA } });
    assert(download.status === 200, `PDF 下载状态 ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert(bytes.length > 100 && bytes.subarray(0, 5).toString() === "%PDF-", "下载内容不是有效 PDF");
    ctx.pdfBytes = bytes.length;
  });

  // 4. RAG ingest + hybrid search 命中 + citation
  await check("4. data-sources ingest + rag/search 命中 + citation", async () => {
    const ingest = await api("POST", "/api/data-sources/ingest", {
      cookie: cookieA,
      body: {
        source: "verify/runtime-check",
        fileName: "annual-report.md",
        content: "# 资产质量\n公司不良率保持稳定，拨备覆盖率充足。\n\n# 盈利能力\n净利润同比增长，ROE 维持高位。"
      }
    });
    assert(ingest.status === 200 && ingest.json.data.indexedChunkCount > 0, `ingest 失败: ${ingest.text}`);
    const search = await api("POST", "/api/rag/search", { cookie: cookieA, body: { query: "公司资产质量如何？", topK: 5 } });
    assert(search.status === 200 && search.json.data.results.length > 0, `rag/search 未命中: ${search.text}`);
    const hit = search.json.data.results.some((result) => (result.text ?? result.chunk?.content ?? result.content ?? "").includes("不良率"));
    assert(hit, "rag/search 结果不包含已 ingest 文档内容");
    if (ctx.artifactCitations.length > 0) {
      console.log(`  citation 证据来自 report artifact（${ctx.artifactCitations.length} 条）`);
    } else {
      const answer = await api("POST", "/api/rag/answer", { cookie: cookieA, body: { question: "公司资产质量如何？", topK: 5 } });
      assert(answer.status === 200 && answer.json.data.answer.citations.length > 0, `rag/answer 无 citation: ${answer.text}`);
      console.log("  citation 证据来自 /api/rag/answer");
    }
  });

  // 5. 跨重启持久化 + stale run 恢复
  await check("5a. SIGKILL 重启后 conversation/messages/run/trace/artifact/PDF 全部可读且终态一致", async () => {
    await stopApi("SIGKILL");
    await startApi();
    const conversationRead = await api("GET", "/api/conversations", { cookie: cookieA });
    assert(conversationRead.status === 200
      && conversationRead.json.data.items.some((item) => item.conversationId === conversationId && item.title === "运行时集成验证会话"),
      "重启后 conversation 丢失");
    const messages = await api("GET", `/api/conversations/${conversationId}/messages`, { cookie: cookieA });
    assert(messages.status === 200 && messages.json.data.items.length > 0, "重启后 messages 丢失");
    const snapshot = await api("GET", `/api/runs/${accepted1.runId}`, { cookie: cookieA });
    assert(snapshot.status === 200 && snapshot.json.data.status === "succeeded", "重启后 run 终态不一致");
    const trace = await api("GET", `/api/traces/${accepted1.requestId}`, { cookie: cookieA });
    assert(trace.status === 200, "重启后 trace 丢失");
    const artifact = await api("GET", `/api/report-artifacts/${ctx.artifactId}`, { cookie: cookieA });
    assert(artifact.status === 200 && artifact.json.data.status === "pdf_ready", "重启后 artifact 状态不一致");
    const download = await fetch(`${BASE}/api/report-artifacts/${ctx.artifactId}/download`, { headers: { cookie: cookieA } });
    assert(download.status === 200, "重启后 PDF 下载失败");
  });

  await check("5b. stale run（running 且 10 分钟未更新）重启恢复为 failed/run_interrupted", async () => {
    // 复用一个已终态 run 行伪造“重启前在途”：状态拨回 running、updated_at 拨到 10 分钟前。
    await psql(DB_NAME, `UPDATE agent_runs SET status='running', updated_at=now()-interval '10 minutes', completed_at=NULL WHERE id='${ctx.reportRunId}'`);
    await stopApi("SIGKILL");
    await startApi();
    const snapshot = await api("GET", `/api/runs/${ctx.reportRunId}`, { cookie: cookieA });
    assert(snapshot.status === 200 && snapshot.json.data.status === "failed", `stale 恢复后状态=${snapshot.json?.data?.status}`);
    const errorCode = snapshot.json.data.error?.code ?? "";
    assert(errorCode.includes("run_interrupted"), `error.code=${errorCode} 不含 run_interrupted`);
  });

  // 6. 跨用户越权：全部 403/404
  await check("6. 第二用户访问第一用户 run/trace/decision/artifact/pdf/messages 全部被拒", async () => {
    const cookieB = await bootstrap("verify-user-b-00000002");
    const targets = [
      ["GET", `/api/runs/${accepted1.runId}`],
      ["GET", `/api/runs/${accepted1.runId}/events`],
      ["GET", `/api/traces/${accepted1.requestId}`],
      ["POST", `/api/runs/${accepted1.runId}/approvals/approval_any/decision`, { decision: "approved", inputDigest: "x" }],
      ["GET", `/api/report-artifacts/${ctx.artifactId}`],
      ["GET", `/api/report-artifacts/${ctx.artifactId}/download`],
      ["GET", `/api/conversations/${conversationId}/messages`]
    ];
    for (const [method, url, body] of targets) {
      const response = await api(method, url, { cookie: cookieB, body });
      assert(response.status === 403 || response.status === 404, `${method} ${url} 越权状态=${response.status}: ${response.text.slice(0, 200)}`);
    }
  });

  // 7. 幂等与竞争
  await check("7a. 同一 clientMessageId 并发 5 次 → 同 runId、user message 只一条", async () => {
    const payload = {
      message: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
      conversationId, mode: "auto", source: "composer", clientMessageId: "verify-cm-race"
    };
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      api("POST", "/api/runs", { cookie: cookieA, body: payload })));
    for (const response of responses) assert(response.status === 202, `并发提交状态=${response.status}: ${response.text}`);
    const runIds = new Set(responses.map((response) => response.json.data.runId));
    assert(runIds.size === 1, `并发产生 ${runIds.size} 个不同 runId`);
    await waitTerminal([...runIds][0], cookieA);
    const messages = await api("GET", `/api/conversations/${conversationId}/messages?limit=100`, { cookie: cookieA });
    const userMessages = messages.json.data.items.filter(
      (item) => item.role === "user" && item.content === payload.message);
    // 会话中此前已有 2 条同内容消息（检查 1/2），并发只应再新增 1 条。
    assert(userMessages.length === 3, `同内容 user message 共 ${userMessages.length} 条（预期 3=检查1+检查2+并发1）`);
  });

  await check("7b. 取消/自然完成竞争 → 唯一终态", async () => {
    const accepted = await submitRun(cookieA, conversationId, "帮我查询 000001.SZ 最近一期净利润和 ROE。", "verify-cm-cancel-race");
    await api("DELETE", `/api/runs/${accepted.runId}`, { cookie: cookieA });
    const snapshot = await waitTerminal(accepted.runId, cookieA);
    assert(["cancelled", "succeeded"].includes(snapshot.status), `竞争后状态=${snapshot.status}`);
    // 终态标记唯一：成功路径是 run_result/run_error，取消路径是 run_status:cancelled，二者互斥只能出现一次。
    const terminalEvents = snapshot.events.filter((event) =>
      event.type === "run_result" || event.type === "run_error"
      || (event.type === "run_status" && TERMINAL.has(event.status)));
    assert(terminalEvents.length === 1, `终态事件数=${terminalEvents.length}: ${JSON.stringify(snapshot.events.map((event) => [event.type, event.status ?? event.error?.code]))}`);
  });

  // 8. 备份恢复：pg_dump → 空库恢复 → 全表行数一致 + 抽查 title
  await check("8. pg_dump 备份恢复到新库，行数与数据一致", async () => {
    const dumpPath = path.join(ARTIFACT_ROOT, "verify-dump.sql");
    await new Promise((resolve, reject) => {
      const child = spawn("docker", ["compose", "exec", "-T", "postgres", "pg_dump", "-U", "aiagent", DB_NAME], { cwd: repoRoot });
      const out = createWriteStream(dumpPath);
      child.stdout.pipe(out);
      child.on("exit", (code) => (code === 0 ? out.close(resolve) : reject(new Error(`pg_dump exit=${code}`))));
    });
    await psql("aiagent", `DROP DATABASE IF EXISTS ${DB_RESTORE} WITH (FORCE)`).catch(() => psql("aiagent", `DROP DATABASE IF EXISTS ${DB_RESTORE}`));
    await psql("aiagent", `CREATE DATABASE ${DB_RESTORE}`);
    await execFileAsync("bash", ["-c", `docker compose exec -T postgres psql -U aiagent -d ${DB_RESTORE} -v ON_ERROR_STOP=1 -q < "${dumpPath}"`], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    const tables = (await psql(DB_NAME, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).split("\n").filter(Boolean);
    assert(tables.length > 0, "未枚举到任何业务表");
    console.log(`  对比表: ${tables.join(", ")}`);
    for (const table of tables) {
      const sourceCount = await psql(DB_NAME, `SELECT count(*) FROM "${table}"`);
      const restoredCount = await psql(DB_RESTORE, `SELECT count(*) FROM "${table}"`);
      assert(sourceCount === restoredCount, `表 ${table} 行数不一致: ${sourceCount} vs ${restoredCount}`);
    }
    const sourceTitle = await psql(DB_NAME, `SELECT title FROM conversations WHERE id='${conversationId}'`);
    const restoredTitle = await psql(DB_RESTORE, `SELECT title FROM conversations WHERE id='${conversationId}'`);
    assert(sourceTitle === restoredTitle && sourceTitle.length > 0, `conversation title 不一致: '${sourceTitle}' vs '${restoredTitle}'`);
    await psql("aiagent", `DROP DATABASE ${DB_RESTORE}`);
    await rm(dumpPath, { force: true });
  });

  // 10 先于 9：graceful shutdown 会结束 API 进程，故障注入需要重启 API 后再做。
  await check("10. SIGTERM graceful shutdown：在途 run 落库 run_interrupted，进程 exit 0", async () => {
    await ensureApi();
    // 伪造一条当前在途 run（updated_at 为现在），shutdown drain 后应被标记 interrupted。
    const accepted = await submitRun(cookieA, conversationId, "帮我查询 000001.SZ 最近一期净利润和 ROE。", "verify-cm-shutdown");
    await waitTerminal(accepted.runId, cookieA);
    await psql(DB_NAME, `UPDATE agent_runs SET status='running', updated_at=now(), started_at=now(), completed_at=NULL WHERE id='${accepted.runId}'`);
    const exitCode = await stopApi("SIGTERM");
    assert(exitCode === 0, `SIGTERM 后退出码=${exitCode}`);
    // 等 shutdown 落库事务可见后再查。
    await sleep(300);
    const status = await psql(DB_NAME, `SELECT status FROM agent_runs WHERE id='${accepted.runId}'`);
    assert(status === "failed", `shutdown 后 run 状态=${status}`);
    const interruptedEvents = await psql(DB_NAME,
      `SELECT count(*) FROM run_events WHERE run_id='${accepted.runId}' AND event_type='run_error' AND payload->'error'->>'code'='run_interrupted'`);
    assert(Number(interruptedEvents) >= 1, "run_events 缺少 run_interrupted 事件");
  });

  // 9. 故障注入：PostgreSQL 停止 → readiness 503 + 结构化错误无泄漏 → 恢复 200。
  // 注意：这里断言的是目标契约。当前实现存在已知缺陷——pg.Pool 未挂 'error' 监听，
  // postgres 停止时空闲连接收到 "terminating connection due to administrator command" 会
  // 触发未处理的 pool error 事件使 API 进程崩溃（见最终报告），因此本检查预期 FAIL。
  let faultEvidence = {};
  await check("9a. PostgreSQL 停止后 API 存活且 /ready 返回 503", async () => {
    await startApi();
    await execFileAsync("docker", ["compose", "stop", "postgres"], { cwd: repoRoot });
    let ready503 = false;
    let connectionFailed = false;
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const ready = await fetch(`${BASE}/ready`);
          if (ready.status === 503) { ready503 = true; break; }
        } catch {
          connectionFailed = true;
          if (apiChild?.exitCode !== null) break;
        }
        await sleep(300);
      }
      const apiDied = !apiChild || apiChild.exitCode !== null;
      faultEvidence = { ready503, connectionFailed, apiDied, exitCode: apiChild?.exitCode };
      // 目标契约：API 必须在依赖故障时保持存活并用 503 表达 readiness。
      assert(!apiDied, `API 进程在 postgres 停止后崩溃 exitCode=${faultEvidence.exitCode}（pg Pool 未处理 idle client error 事件）`);
      assert(ready503, "postgres 停止后 /ready 未返回 503");
    } finally {
      // 无论成败都先恢复 postgres，避免影响后续检查与本机其他验证。
      await execFileAsync("docker", ["compose", "start", "postgres"], { cwd: repoRoot });
    }
  });

  await check("9b. 故障窗口内业务接口为稳定结构化错误且无敏感泄漏", async () => {
    // API 若已因 9a 的缺陷崩溃，则在 postgres 已恢复的前提下重启，再模拟“依赖曾故障”的响应契约：
    // 直接以 stop→请求→start 的最短窗口验证错误信封（若进程再次崩溃则如实 FAIL）。
    await ensureApi();
    await execFileAsync("docker", ["compose", "stop", "postgres"], { cwd: repoRoot });
    try {
      const leakPatterns = ["ECONNREFUSED", "password", "postgres://", "aiagent-local", "127.0.0.1:5432"];
      const search = await api("POST", "/api/rag/search", { cookie: cookieA, body: { query: "公司资产质量如何？", topK: 5 } });
      assert(search.json && typeof search.json === "object", `rag/search 故障响应非 JSON: ${search.text.slice(0, 200)}`);
      assert(search.json.ok === false && typeof search.json.error?.code === "string",
        `rag/search 故障响应非 ok:false 结构: ${search.text.slice(0, 300)}`);
      const run = await api("GET", `/api/runs/${accepted1.runId}`, { cookie: cookieA });
      assert(run.json && typeof run.json === "object", `run 故障响应非 JSON: ${run.text.slice(0, 200)}`);
      // run 读取允许 ok:false 信封或 Fastify 通用 500 结构，但都必须是稳定话术。
      const runStructured = (run.json.ok === false && typeof run.json.error?.code === "string")
        || (run.status === 500 && run.json.error === "Internal Server Error");
      assert(runStructured, `run 故障响应结构不稳定: ${run.text.slice(0, 300)}`);
      for (const body of [search.text, run.text]) {
        for (const pattern of leakPatterns) {
          assert(!body.includes(pattern), `故障响应泄漏 '${pattern}': ${body.slice(0, 200)}`);
        }
      }
    } finally {
      await execFileAsync("docker", ["compose", "start", "postgres"], { cwd: repoRoot });
    }
  });

  await check("9c. PostgreSQL 恢复后 /ready 回到 200", async () => {
    // API 若已在故障窗口崩溃，重启进程验证端到端恢复；存活则直接验证。
    await ensureApi();
    let recovered = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const ready = await fetch(`${BASE}/ready`);
        if (ready.status === 200) { recovered = true; break; }
      } catch { /* 连接尚未恢复 */ }
      await sleep(500);
    }
    assert(recovered, "postgres 恢复后 /ready 未回到 200");
  });
}

const failed = () => results.filter((result) => !result.ok);

try {
  await main();
} catch (error) {
  console.log(`FATAL 主流程中断: ${error?.stack ?? error}`);
} finally {
  if (apiChild && apiChild.exitCode === null) {
    apiChild.kill("SIGKILL");
    await new Promise((resolve) => apiChild.once("exit", resolve)).catch(() => {});
  }
  await rm(ARTIFACT_ROOT, { recursive: true, force: true }).catch(() => {});
  // 恢复库若因失败残留，尽力清理。
  await psql("aiagent", `DROP DATABASE IF EXISTS ${DB_RESTORE} WITH (FORCE)`).catch(() => {});
}

const failures = failed();
console.log(`\n==== 汇总: ${results.length - failures.length}/${results.length} PASS ====`);
for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.ok ? "" : ` — ${result.error?.message}`}`);
}
process.exit(failures.length > 0 || results.length === 0 ? 1 : 0);
