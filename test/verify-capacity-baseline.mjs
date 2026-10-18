#!/usr/bin/env node
/**
 * 容量 / 故障演练基线验证脚本（docs/v1.2 §4 P2/P3：量化容量 / 故障演练基线）。
 *
 * 目标：补齐 verify-runtime-integration.mjs 缺失的「量化基线」——不是 pass/fail，而是打印真实数字：
 *   1) 吞吐 / 时延：驱动 N 条 run，报告 P50/P95/P99 时延与吞吐（runs/sec）。
 *   2) 并发长连接：打开 M 条 SSE 订阅（/api/runs/:runId/events），报告实例可维持的并发连接数
 *      与事件投递尾时延（P50/P95/P99）。
 *   3) Provider 故障注入 + 熔断：强制 LLM provider 失败，断言熔断器跳闸 OPEN、冷却后恢复到 closed，
 *      并报告测得的跳闸 / 恢复时刻（trip → half-open → closed）。
 *
 * 依赖（由脚本自动拉起的验证服务器提供，离线即可运行，无需 Postgres/Redis）：
 *   - apps/finance-api/dist/verify-server.js（通过 `pnpm --filter @aiagent/finance-api build` 或 `pnpm build` 生成）。
 *   - 测试替身模型（test-double）确定性、不发起外部请求；消息不含 ticker/报告/数字关键词时直接回答，
 *     因而吞吐 / 并发测量不依赖任何真实 LLM。
 *
 * 运行方式：
 *   1. （可选）pnpm build                       # 生成 apps/finance-api/dist/verify-server.js
 *   2. node test/verify-capacity-baseline.mjs   # 自动 spawn 验证服务器并测量
 *
 * 说明：脚本优先用 apps/finance-api/dist/verify-server.js；若整仓 tsc -b 因无关工作树类型错误未能产出 dist，
 * 则自动回退到 node_modules/.bin/tsx 直接运行源码（依赖各 package 的预构建 dist）。两种方式都离线可跑，
 * 无需 Postgres/Redis。验证服务器仅启用内存事实源（createInMemoryApiTestRuntime）。
 *
 * 可调 env（均为可选）：
 *   AIAGENT_VERIFY_PORT            验证服务器端口（默认 3211）
 *   AIAGENT_VERIFY_RUNS            吞吐测量 run 条数（默认 30）
 *   AIAGENT_VERIFY_CONCURRENCY     并发 SSE 连接数（默认 64）
 *   AIAGENT_VERIFY_CB_FAILURES     熔断连续失败阈值（默认 2）
 *   AIAGENT_VERIFY_CB_COOLDOWN_MS  熔断冷却窗口 ms（默认 3000）
 *
 * 预期数字（参考，受本机 worker 500ms 轮询间隔影响）：
 *   - 吞吐：受 run-worker 串行 claim（pollIntervalMs=500）限制，约 1.5~3 runs/sec；P50 时延约 0.5~0.9s。
 *   - 并发：M 条 SSE 连接应全部建立并保持存活（仅受文件描述符 / 内存限制）。
 *   - 熔断：连续 AIAGENT_VERIFY_CB_FAILURES 次失败后跳闸 OPEN；冷却 ~AIAGENT_VERIFY_CB_COOLDOWN_MS 后
 *     half-open，provider 恢复后探针成功 → closed（recovery 总时延 ≈ 冷却窗口）。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm, mkdir } from "node:fs/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.AIAGENT_VERIFY_PORT ?? 3211);
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUNS = Number(process.env.AIAGENT_VERIFY_RUNS ?? 30);
const CONCURRENCY = Number(process.env.AIAGENT_VERIFY_CONCURRENCY ?? 64);
const CB_FAILURES = Number(process.env.AIAGENT_VERIFY_CB_FAILURES ?? 2);
const CB_COOLDOWN_MS = Number(process.env.AIAGENT_VERIFY_CB_COOLDOWN_MS ?? 3000);
// 验证服务器入口：优先用预编译 dist；若整仓 tsc -b 因无关的工作树类型错误中断，
// 则回退到 tsx 直接运行源码（依赖各 package 的预构建 dist），保证脚本离线可跑。
const API_DIST = path.join(repoRoot, "apps/finance-api/dist/verify-server.js");
const API_SRC = path.join(repoRoot, "apps/finance-api/src/verify-server.ts");
const TSX_BIN = path.join(repoRoot, "node_modules/.bin/tsx");
const ARTIFACT_ROOT = path.join(repoRoot, "test", ".artifacts-capacity-verify");
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** @type {import("child_process").ChildProcess | null} */
let apiChild = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

/**
 * 通用 JSON API 调用。
 * @param {string} method HTTP 方法。
 * @param {string} url 路径。
 * @param {{cookie?: string, body?: unknown}} [options]
 */
async function api(method, url, options = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE/非 JSON 允许 */ }
  return { status: response.status, json, text };
}

/** 通过 identity bootstrap 拿到会话 cookie。 */
async function bootstrap() {
  const response = await fetch(`${BASE}/api/identity/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitorId: `capacity-verify-${Date.now()}`, fingerprintVersion: "verify-v1" })
  });
  if (response.status !== 200) throw new Error(`bootstrap 失败: ${await response.text()}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("bootstrap 缺少 set-cookie");
  return setCookie.split(";")[0];
}

/** 创建会话并返回 conversationId。 */
async function createConversation(cookie) {
  const response = await api("POST", "/api/conversations", { cookie, body: { title: "容量基线验证" } });
  if (response.status !== 201) throw new Error(`创建会话失败 ${response.status}: ${response.text}`);
  return response.json.data.conversationId;
}

/** 提交一条 run（benign 消息，直接回答、不触发工具调用），返回 {runId, t0}。 */
async function submitRun(cookie, conversationId, message, clientMessageId) {
  const t0 = Date.now();
  const response = await api("POST", "/api/runs", {
    cookie,
    body: { message, conversationId, mode: "auto", source: "composer", clientMessageId }
  });
  if (response.status !== 202) throw new Error(`POST /api/runs 状态 ${response.status}: ${response.text}`);
  return { runId: response.json.data.runId, t0 };
}

/** 轮询 run 快照直到终态，返回最终 status。 */
async function waitTerminal(runId, cookie, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api("GET", `/api/runs/${runId}`, { cookie });
    if (response.status === 200 && TERMINAL.has(response.json.data.status)) return response.json.data.status;
    await sleep(100);
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到达终态`);
}

/**
 * 不触发工具调用的「闲聊」消息，确保测试替身直接文本回答、run 快速完成。
 * 必须避开：数字算式、\d{6}.(SZ|SH|BJ) ticker、研报/报告/PDF/公告/年报/检索/净利润/ROE/营收/财务指标。
 */
const BENIGN = [
  "请用一句话介绍你是什么。",
  "今天我们来随便聊聊金融吧。",
  "能给我讲一个基础的理财小常识吗？",
  "你对长期投资有什么看法？",
  "简单说说分散投资的意义。"
];
const benign = (i) => BENIGN[i % BENIGN.length];

/**
 * 1) 吞吐 / 时延：驱动 N 条 run，测量每条 submit→terminal 时延与整体吞吐。
 * @returns {Promise<{count:number, p50:number, p95:number, p99:number, throughput:number, spanMs:number}>}
 */
async function measureThroughput(cookie, conversationId) {
  const submitted = [];
  for (let i = 0; i < RUNS; i += 1) {
    submitted.push(await submitRun(cookie, conversationId, benign(i), `cap-tp-${i}`));
  }
  const latencies = [];
  for (const { runId, t0 } of submitted) {
    await waitTerminal(runId, cookie);
    latencies.push(Date.now() - t0);
  }
  latencies.sort((a, b) => a - b);
  const firstStart = submitted[0].t0;
  const lastEnd = Math.max(...latencies.map((_, i) => submitted[i].t0 + latencies[i]));
  const spanMs = lastEnd - firstStart;
  return {
    count: RUNS,
    p50: Math.round(pct(latencies, 50)),
    p95: Math.round(pct(latencies, 95)),
    p99: Math.round(pct(latencies, 99)),
    throughput: Number((RUNS / (spanMs / 1000)).toFixed(3)),
    spanMs: Math.round(spanMs)
  };
}

/**
 * 2) 并发长连接：打开 M 条 SSE 订阅并保持，报告维持的连接数与事件投递尾时延。
 * @returns {Promise<{opened:number, aliveAfter2s:number, p50:number, p95:number, p99:number}>}
 */
async function measureConcurrency(cookie, conversationId) {
  const conns = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const { runId } = await submitRun(cookie, conversationId, benign(i), `cap-cc-${i}`);
    const controller = new AbortController();
    const response = await fetch(`${BASE}/api/runs/${runId}/events`, {
      headers: { cookie },
      signal: controller.signal
    });
    const reader = response.body.getReader();
    const conn = { runId, reader, controller, tOpen: Date.now(), tTerm: null, closed: false, established: response.status === 200 };
    // 独立读取协程：检测终态事件或连接关闭，记录投递时刻。
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { conn.closed = true; break; }
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "agent_end" || ev.type === "run_error") conn.tTerm = Date.now();
            } catch { /* 忽略非 JSON 行 */ }
          }
          if (conn.tTerm && conn.closed) break;
        }
      } catch { conn.closed = true; }
      if (conn.tTerm === null) conn.tTerm = Date.now();
    })();
    conns.push(conn);
  }

  const opened = conns.filter((c) => c.established).length;
  // 维持 2s，统计仍存活的连接数（事件投递尾时延测量前先确认连接可持续）。
  await sleep(2000);
  const aliveAfter2s = conns.filter((c) => !c.closed).length;

  // 等待全部连接收尾（run 由 worker 串行执行），记录每条连接的「连接建立→终态事件」时延。
  await Promise.all(conns.map(async (c) => {
    // 兜底：最多等 60s。
    const deadline = Date.now() + 60_000;
    while (!c.closed && Date.now() < deadline) await sleep(100);
    c.controller.abort();
  }));
  const lats = conns.filter((c) => c.tTerm).map((c) => c.tTerm - c.tOpen).sort((a, b) => a - b);
  return {
    opened,
    aliveAfter2s,
    p50: Math.round(pct(lats, 50)),
    p95: Math.round(pct(lats, 95)),
    p99: Math.round(pct(lats, 99))
  };
}

/**
 * 3) Provider 故障注入 + 熔断：断言跳闸 OPEN，恢复后回到 closed，并报告测得时刻。
 * @returns {Promise<{threshold:number, tripObservedMs:number, cooldownObservedMs:number, recoveryMs:number, probeStatus:string}>}
 */
async function measureBreaker(cookie, conversationId) {
  // 打开故障注入（provider 持续失败）。
  await api("POST", "/api/__verify/fail-inject", { cookie, body: { enabled: true } });
  const tStart = Date.now();

  // 提交 threshold 条必然失败的 run，触发连续失败累计到跳闸。
  const failing = [];
  for (let i = 0; i < CB_FAILURES; i += 1) {
    failing.push(await submitRun(cookie, conversationId, benign(i), `cap-br-${i}`));
  }

  // 轮询熔断元数据直到 trippedAt 出现（最多 20s）。
  let meta = null;
  while (Date.now() - tStart < 20_000) {
    const response = await api("GET", "/api/__verify/breaker", { cookie });
    meta = response.json;
    if (meta?.trippedAt != null) break;
    await sleep(50);
  }
  if (!meta || meta.trippedAt == null) throw new Error("熔断器未在阈值内跳闸 OPEN");
  const mTripped = meta;
  const tripObservedMs = mTripped.trippedAt - tStart; // 同机时钟，近似跳闸时延

  // provider 恢复：关闭故障注入。等待冷却窗口结束。
  await api("POST", "/api/__verify/fail-inject", { cookie, body: { enabled: false } });
  await sleep(CB_COOLDOWN_MS + 300);
  // 冷却窗口刚过：读一次元数据，getState 惰性把 open→half-open 并记下 halfOpenAt（即测得冷却窗口）。
  const halfOpenMeta = (await api("GET", "/api/__verify/breaker", { cookie })).json;

  // 提交探针 run：此时应已 half-open，成功执行使熔断器闭合（P2 恢复链路）。
  const probe = await submitRun(cookie, conversationId, benign(999), "cap-br-probe");
  const probeStatus = await waitTerminal(probe.runId, cookie);

  // 读取恢复后的熔断元数据。
  const recovered = (await api("GET", "/api/__verify/breaker", { cookie })).json;
  const cooldownObservedMs = (halfOpenMeta.halfOpenAt ?? recovered.halfOpenAt ?? mTripped.trippedAt) - mTripped.trippedAt;
  const recoveryMs = (recovered.recoveredAt ?? mTripped.trippedAt) - mTripped.trippedAt;

  // 断言恢复：状态回到 closed 且探针成功完成（P2：OPEN 快速失败不重置冷却、可恢复）。
  const recoveredToClosed = recovered.state === "closed" && probeStatus === "completed";
  if (!recoveredToClosed) {
    throw new Error(`熔断未正确恢复：state=${recovered.state} probeStatus=${probeStatus}`);
  }
  return { threshold: CB_FAILURES, tripObservedMs: Math.round(tripObservedMs), cooldownObservedMs: Math.round(cooldownObservedMs), recoveryMs: Math.round(recoveryMs), probeStatus };
}

/** 拉起验证服务器并等待 /ready。 */
async function startApi() {
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  // 选择入口：dist 存在用 node 直接跑；否则用 tsx 跑源码（绕开整仓 tsc -b 的无关类型错误）。
  const useDist = await import("node:fs").then((fs) => fs.existsSync(API_DIST)).catch(() => false);
  const [command, entryArg] = useDist ? ["node", API_DIST] : [TSX_BIN, API_SRC];
  apiChild = spawn(command, [entryArg], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      AIAGENT_VERIFY_MODE: "1",
      AIAGENT_VERIFY_LLM_FAIL: "0",
      AIAGENT_VERIFY_CB_FAILURES: String(CB_FAILURES),
      AIAGENT_VERIFY_CB_COOLDOWN_MS: String(CB_COOLDOWN_MS),
      ARTIFACT_STORAGE_ROOT: ARTIFACT_ROOT
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  apiChild.stderr.on("data", () => {});
  apiChild.stdout.on("data", () => {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (apiChild.exitCode !== null) throw new Error(`验证服务器提前退出 exitCode=${apiChild.exitCode}`);
    try {
      const response = await fetch(`${BASE}/ready`);
      if (response.status === 200) return;
    } catch { /* 尚未监听 */ }
    await sleep(250);
  }
  throw new Error("验证服务器 readiness 等待超时");
}

async function stopApi() {
  const child = apiChild;
  if (!child) return;
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(5_000).then(() => "timeout")]);
  apiChild = null;
}

const results = {};
try {
  await startApi();
  const cookie = await bootstrap();
  const conversationId = await createConversation(cookie);

  results.throughput = await measureThroughput(cookie, conversationId);
  results.concurrency = await measureConcurrency(cookie, conversationId);
  results.breaker = await measureBreaker(cookie, conversationId);
} catch (error) {
  results.error = error?.stack ?? String(error);
} finally {
  await stopApi();
  await rm(ARTIFACT_ROOT, { recursive: true, force: true }).catch(() => {});
}

// ---- 汇总打印 ----
console.log("\n========== 容量 / 故障演练基线汇总 ==========");
if (results.error) {
  console.log(`ERROR: ${results.error}`);
  process.exit(1);
}
const t = results.throughput;
const c = results.concurrency;
const b = results.breaker;
console.log(`[吞吐/时延]  run 数=${t.count}  总耗时=${t.spanMs}ms  吞吐=${t.throughput} runs/sec`);
console.log(`            时延 P50=${t.p50}ms  P95=${t.p95}ms  P99=${t.p99}ms`);
console.log(`[并发长连接] 建立连接=${c.opened}  维持2s后仍存活=${c.aliveAfter2s}`);
console.log(`            事件投递尾时延 P50=${c.p50}ms  P95=${c.p95}ms  P99=${c.p99}ms`);
console.log(`[熔断演练]   连续失败阈值=${b.threshold}  跳闸时延≈${b.tripObservedMs}ms`);
console.log(`            配置冷却窗口=${CB_COOLDOWN_MS}ms  测得 跳闸→恢复closed 总时延=${b.recoveryMs}ms  (探针run=${b.probeStatus})`);
console.log("============================================");
process.exit(0);
