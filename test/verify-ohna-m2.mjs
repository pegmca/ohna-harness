#!/usr/bin/env node
/**
 * ohna-cli M2 端到端验证（无需真实 API key）。
 *
 * 用本地 OpenAI 兼容桩驱动真实 CLI 进程，自动覆盖：
 * - C-M2-1 --resume：退出后按会话 id 恢复历史并继续；
 * - C-M2-2 /cost：REPL 内看到累计 token 与成本；
 * - C-M2-3 compaction：60KB 文件 read 的 ToolResult 触发压缩，且 tokensAfter 真正低于窗口阈值；
 * - C-M2-4 deadline：到期后干净停止；
 * - C-M2-5 max-turns：恰好 3 个 assistant 回合后停止并落盘；
 * - C-M2-6 max-cost：零预算路径不调用模型；
 * - P1-3 provider 400：打印错误、单次模式非零退出、JSONL 不写入空 assistant；
 * - P2-4 / P2-5 / P2-6 / P3-9 / P3-12：自然结束不误报、预算检查时机、工作区告警、
 *   参数缺失告警与管道多行串行执行。
 *
 * 运行：node test/verify-ohna-m2.mjs
 * 说明：所有会话写入临时 HOME，绝不触碰真实 `~/.ohna`。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "apps/ohna-cli/dist/index.js");
const { estimateContextTokens, estimateTokens } = await import(join(repoRoot, "packages/agent/dist/compaction.js"));

/** 压缩用例的上下文窗口。 */
const COMPACT_WINDOW = 20_000;
/** 阈值 = window - reserve（reserve = min(16384, window * 0.2)）。 */
const COMPACT_THRESHOLD = COMPACT_WINDOW - Math.floor(COMPACT_WINDOW * 0.2);

/**
 * 把 chunk 列表编码为 SSE 响应。
 *
 * @param chunks chat completion chunk 列表。
 * @returns HTTP Response 流。
 */
function sseBody(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * 生成一次工具调用响应。
 *
 * @param id 响应 id。
 * @param name 工具名。
 * @param args 工具参数。
 * @param usage 可选 usage。
 * @returns SSE 文本。
 */
function toolCallBody(id, name, args, usage = { prompt_tokens: 100, completion_tokens: 10 }) {
  return sseBody([
    {
      id,
      model: "stub",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${id}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      model: "stub",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage,
    },
  ]);
}

/**
 * 生成一次纯文本响应。
 *
 * @param id 响应 id。
 * @param text 文本。
 * @param usage 可选 usage。
 * @returns SSE 文本。
 */
function textBody(id, text, usage = { prompt_tokens: 100, completion_tokens: 10 }) {
  return sseBody([
    {
      id,
      model: "stub",
      choices: [{ delta: { content: text }, finish_reason: "stop" }],
      usage,
    },
  ]);
}

/**
 * 启动桩模型服务：根据最后一条 user 文本与是否已有 tool 消息决定响应。
 *
 * @returns {Promise<{ server: import("node:http").Server, baseUrl: string }>}
 */
async function startStubServer() {
  /** 记录全部请求体：D3 用它检查 --resume 的首个请求是否仍超窗。 */
  const requests = [];
  /** 摘要请求计数：验证摘要调用的 usage 确实计入了会话累计。 */
  let summaryCount = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const systemText = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
      const hasToolMessage = messages.some((m) => m.role === "tool");

      // 摘要调用：返回短摘要与真实 usage，验证 P1-2 摘要成本计入会话。
      if (systemText.includes("上下文压缩器")) {
        summaryCount += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(textBody("stub-summary", "这是历史摘要", { prompt_tokens: 100, completion_tokens: 10 }));
        return;
      }

      if (userText.includes("ERROR")) {
        // provider 400：不是 SSE，而是普通 JSON 错误体。
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });

      // D3：同一个 assistant 回合内发两次大文件 read（每次约 50KB），复现
      // 「运行期压缩后 usage 很小、history 仍很大」的落盘场景。
      if (userText.includes("READ2")) {
        if (!hasToolMessage) {
          res.end(
            sseBody([
              {
                id: "stub-read2",
                model: "stub",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-read-a",
                          type: "function",
                          function: { name: "read", arguments: JSON.stringify({ path: "big.txt" }) },
                        },
                        {
                          index: 1,
                          id: "call-read-b",
                          type: "function",
                          function: { name: "read", arguments: JSON.stringify({ path: "big2.txt" }) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: "stub-read2",
                model: "stub",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 100, completion_tokens: 10 },
              },
            ]),
          );
        } else {
          // 故意报告很小的 usage：模拟运行期压缩后的调用（loop 只看到摘要 + 尾部）。
          // 旧逻辑会把这种 history 误判为 ~120 token，从而跳过落盘压缩。
          res.end(textBody("stub-read2-done", "已读取两个大文件。", { prompt_tokens: 120, completion_tokens: 10 }));
        }
        return;
      }

      if (userText.includes("RESUME")) {
        res.end(textBody("stub-resume", "已恢复并继续。", { prompt_tokens: 80, completion_tokens: 10 }));
        return;
      }

      if (userText.includes("READ")) {
        if (!hasToolMessage) {
          // 真实模型常见形态：先说一句「我先读取文件」，再发 read 调用。
          // 前置文本让保留尾部凑够 keepRecentTokens，从而把 read 的 ToolResult 留在尾部，
          // 真正走到「截断超大 ToolResult 文本」的硬收敛分支。
          const intro = "我先读取这个 60KB 文件的关键部分。".repeat(1_200);
          res.end(
            sseBody([
              {
                id: "stub-read-intro",
                model: "stub",
                choices: [{ delta: { content: intro }, finish_reason: null }],
              },
              {
                id: "stub-read",
                model: "stub",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-stub-read",
                          type: "function",
                          function: { name: "read", arguments: JSON.stringify({ path: "big.txt", limit: 100 }) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: "stub-read",
                model: "stub",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 100, completion_tokens: 10 },
              },
            ]),
          );
        } else {
          // 第二个回合报告 25100 input token，模拟真实 provider 对大 ToolResult 的计数；
          // 压缩逻辑必须让 tokensAfter 真正下降，而不是只把前缀换成摘要。
          res.end(textBody("stub-read-done", "已读取大文件。", { prompt_tokens: 25_100, completion_tokens: 10 }));
        }
        return;
      }

      if (userText.includes("TEXT")) {
        res.end(textBody("stub-text", "已完成。"));
        return;
      }

      // TOOL / 默认：持续请求 ls（只读工具，无需确认），驱动多回合直到预算/时限停止。
      res.end(toolCallBody("stub-tool", "ls", { path: "." }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, summaryCount: () => summaryCount };
}

/**
 * 运行 CLI 子进程。
 *
 * @param args 参数列表。
 * @param env 额外环境变量。
 * @param cwd 工作区。
 * @param input 可选 stdin 内容（REPL 用）。
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function runCli(args, env, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

/**
 * 分阶段向 REPL 写入输入：每段之间等待一段时间，模拟真人「等回答完再敲下一条」。
 *
 * @param args 参数列表。
 * @param env 额外环境变量。
 * @param cwd 工作区。
 * @param chunks 输入片段与等待毫秒数。
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function runCliStaged(args, env, cwd, chunks) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    (async () => {
      for (const chunk of chunks) {
        if (chunk.delayMs) await new Promise((done) => setTimeout(done, chunk.delayMs));
        child.stdin.write(chunk.data);
      }
      await new Promise((done) => setTimeout(done, 500));
      child.stdin.end();
    })().catch(reject);
  });
}

/**
 * 读取会话 JSONL。
 *
 * @param file 文件路径。
 * @returns {{header: any, messages: any[]}}
 */
function readSession(file) {
  const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  return { header: lines[0], messages: lines.slice(1).map((line) => line.message) };
}

/**
 * 列出会话文件。
 *
 * @param home 临时 HOME。
 * @returns 文件名列表。
 */
function listSessionFiles(home) {
  return readdirSync(join(home, ".ohna", "sessions")).filter((name) => name.endsWith(".jsonl"));
}

/**
 * 按标题定位会话文件（标题在首条用户输入时固定，测试用它避免依赖目录顺序）。
 *
 * @param home 临时 HOME。
 * @param title 会话标题。
 * @returns 文件路径。
 */
function findSessionByTitle(home, title) {
  const dir = join(home, ".ohna", "sessions");
  const match = listSessionFiles(home).find((name) => readSession(join(dir, name)).header.title === title);
  assert.ok(match, `未找到标题为 "${title}" 的会话`);
  return join(dir, match);
}

const root = mkdtempSync(join(realpathSync(tmpdir()), "ohna-m2-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
const workspace2 = join(root, "workspace2");
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(workspace2, { recursive: true });
writeFileSync(join(workspace, "demo.txt"), "hello\n");
// 60KB 文本文件：600 行 × 约 100 字节，read 工具会按 50KB 上限截断后回喂，
// 足以复现「单条 ToolResult 很大」的压缩场景。
writeFileSync(
  join(workspace, "big.txt"),
  Array.from({ length: 600 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(96)}`).join("\n"),
  "utf8",
);
// 第二个约 60KB 文件：D3 在同一个 assistant 回合内并发读取两份大文件。
writeFileSync(
  join(workspace, "big2.txt"),
  Array.from({ length: 600 }, (_, index) => `${String(index).padStart(3, "0")}${"y".repeat(96)}`).join("\n"),
  "utf8",
);

const { server, baseUrl, requests, summaryCount } = await startStubServer();
const baseEnv = {
  HOME: home,
  AIAGENT_LLM_API_KEY_DEEPSEEK: "stub-key",
  AIAGENT_LLM_BASE_URL_DEEPSEEK: baseUrl,
  AIAGENT_LLM_MODEL_DEEPSEEK: "stub",
  AIAGENT_LLM_COST_IN_DEEPSEEK: "1",
  AIAGENT_LLM_COST_OUT_DEEPSEEK: "1",
};

try {
  // C-M2-5：max-turns（同时验证 --key=value 写法）
  const maxTurns = await runCli(
    ["--yes", "--max-turns=3", "TOOL 测试"],
    baseEnv,
    workspace,
  );
  assert.equal(maxTurns.code, 0, maxTurns.stderr);
  assert.match(maxTurns.stdout, /⏹ 已停止：达到最大回合数/);
  const firstFile = listSessionFiles(home)[0];
  assert.ok(firstFile, "max-turns run 应落盘会话");
  const firstSession = readSession(join(home, ".ohna", "sessions", firstFile));
  const assistantCount = firstSession.messages.filter((message) => message.role === "assistant").length;
  assert.equal(assistantCount, 3, `期望恰好 3 个 assistant，实际 ${assistantCount}`);
  assert.equal(firstSession.messages.length, 7, `期望 user + 3 assistant + 3 toolResult，实际 ${firstSession.messages.length}`);
  assert.ok(firstSession.header.usage.cost > 0, "会话应累计非零成本");
  assert.ok(firstSession.header.usage.input > 0, "会话应累计非零输入 token");
  console.log("✓ C-M2-5 max-turns 恰好 3 轮后停止并落盘；usage 非零");

  // P2-4：模型给出最终文本时自然结束，不能误报「已停止」
  const natural = await runCli(
    ["--yes", "--max-turns", "1", "TEXT 自然结束"],
    baseEnv,
    workspace,
  );
  assert.equal(natural.code, 0, natural.stderr);
  assert.doesNotMatch(natural.stdout, /⏹ 已停止/, "文本回合自然结束不应打印停止原因");
  const naturalSession = readSession(findSessionByTitle(home, "TEXT 自然结束"));
  assert.equal(naturalSession.messages.filter((message) => message.role === "assistant").length, 1);
  console.log("✓ P2-4 自然完成不误报「已停止」");

  // C-M2-6：零预算（--max-cost 0）在 run 前停止，不调用模型
  const maxCost = await runCli(
    ["--yes", "--max-turns", "10", "--max-cost", "0", "TOOL 预算"],
    baseEnv,
    workspace,
  );
  assert.equal(maxCost.code, 0, maxCost.stderr);
  assert.match(maxCost.stdout, /⏹ 已停止：达到成本预算/);
  assert.doesNotMatch(maxCost.stdout, /⏺/, "零预算不应调用任何工具/模型");
  const zeroBudgetSession = readSession(findSessionByTitle(home, "TOOL 预算"));
  assert.equal(zeroBudgetSession.messages.length, 0, "零预算路径不应写入模型消息");
  console.log("✓ C-M2-6 零预算在 run 前停止且不调用模型");

  // C-M2-4：deadline
  const deadline = await runCli(
    ["--yes", "--max-turns", "10", "--deadline-ms", "1", "TOOL 截止"],
    baseEnv,
    workspace,
  );
  assert.equal(deadline.code, 0, deadline.stderr);
  assert.match(deadline.stdout, /⏹ 已停止：达到截止时间/);
  assert.ok(listSessionFiles(home).some((name) => readSession(join(home, ".ohna", "sessions", name)).header.title === "TOOL 截止"));
  console.log("✓ C-M2-4 deadline 到期停止并落盘");

  // C-M2-1：resume（历史消息增长，标题保持首次输入）
  const sessionId = firstFile.slice(0, -".jsonl".length);
  const resumed = await runCli(
    ["--yes", "--resume", sessionId, "--max-turns", "1", "TEXT 继续"],
    baseEnv,
    workspace,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const resumedSession = readSession(join(home, ".ohna", "sessions", firstFile));
  assert.ok(
    resumedSession.messages.length > firstSession.messages.length,
    "resume 后消息数应增长",
  );
  assert.equal(resumedSession.header.title, firstSession.header.title);
  assert.match(resumed.stdout, /累计 token/);
  console.log("✓ C-M2-1 resume 恢复历史并继续");

  // P2-6：跨工作区 resume 必须给出明确中文警告，但不阻断恢复
  const crossWorkspace = await runCli(
    ["--yes", "--resume", sessionId, "--max-turns", "1", "TEXT 换目录"],
    baseEnv,
    workspace2,
  );
  assert.equal(crossWorkspace.code, 0, crossWorkspace.stderr);
  assert.match(crossWorkspace.stderr, /工作区为 .*，与当前目录 .* 不一致/);
  console.log("✓ P2-6 跨工作区恢复打印警告且不阻断");

  // C-M2-3：60KB 文件 read 产生大 ToolResult，触发会话级压缩并真正降到窗口以下
  const compactEnv = { ...baseEnv, AIAGENT_LLM_CONTEXT_WINDOW_DEEPSEEK: String(COMPACT_WINDOW) };
  const compact = await runCli(
    ["--yes", "--max-turns", "2", "READ 压缩测试"],
    compactEnv,
    workspace,
  );
  assert.equal(compact.code, 0, compact.stderr);
  const compactMatch = compact.stdout.match(/会话上下文已压缩：约 (\d+) → (\d+) token/);
  assert.ok(compactMatch, `应打印压缩前后 token：${compact.stdout}`);
  const tokensBefore = Number(compactMatch[1]);
  const tokensAfter = Number(compactMatch[2]);
  assert.ok(tokensAfter < tokensBefore, `tokensAfter(${tokensAfter}) 应 < tokensBefore(${tokensBefore})`);
  assert.ok(
    tokensAfter <= COMPACT_THRESHOLD,
    `tokensAfter(${tokensAfter}) 应 <= 窗口阈值 ${COMPACT_THRESHOLD}`,
  );
  const compactSession = readSession(findSessionByTitle(home, "READ 压缩测试"));
  assert.equal(compactSession.messages[0].role, "compaction");
  assert.equal(compactSession.messages[0].summary, "这是历史摘要");
  // 不只看日志：用与运行时相同的估算函数重算 JSONL 里的真实消息序列。
  const persistedTokens = estimateContextTokens(compactSession.messages);
  assert.ok(
    persistedTokens <= COMPACT_THRESHOLD,
    `JSONL 重算 tokensAfter=${persistedTokens} 应 <= 窗口阈值 ${COMPACT_THRESHOLD}`,
  );
  assert.ok(persistedTokens < tokensBefore, "JSONL 重算结果必须小于压缩前 token");
  // 摘要调用（input 100）与两轮 assistant（input 100 + 25100）都必须计入会话 usage。
  assert.ok(
    compactSession.header.usage.input >= 25_300,
    `摘要 usage 应计入会话，实际 input=${compactSession.header.usage.input}`,
  );
  const keptToolResult = compactSession.messages.find((message) => message.role === "toolResult");
  assert.ok(keptToolResult, "压缩后应保留最近的大 ToolResult");
  assert.match(
    keptToolResult.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    /已截断以适配上下文窗口/,
  );
  console.log("✓ C-M2-3 60KB read ToolResult 压缩后 tokensAfter 低于窗口阈值，摘要 usage 计入会话");

  // D3：单个 assistant 回合内两次大文件 read → 运行期压缩后 usage 很小，落盘仍必须压缩。
  const summaryBeforeD3 = summaryCount();
  const d3 = await runCli(
    ["--yes", "READ2 双读压缩"],
    compactEnv,
    workspace,
  );
  assert.equal(d3.code, 0, d3.stderr);
  const d3Log = d3.stdout.match(/会话上下文已压缩：约 (\d+) → (\d+) token/);
  assert.ok(d3Log, `D3 应触发落盘压缩：${d3.stdout}`);
  const d3Before = Number(d3Log[1]);
  const d3After = Number(d3Log[2]);
  const d3SessionFile = findSessionByTitle(home, "READ2 双读压缩");
  const d3Session = readSession(d3SessionFile);
  assert.equal(d3Session.messages[0].role, "compaction", "JSONL 首条必须是 compaction");
  // 不只看日志：逐条 estimateTokens 重算 JSONL 的内容 token。
  const d3ContentTokens = d3Session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.ok(
    d3ContentTokens <= COMPACT_THRESHOLD,
    `JSONL 内容估算 ${d3ContentTokens} 应 <= 窗口阈值 ${COMPACT_THRESHOLD}`,
  );
  assert.ok(d3Before > COMPACT_THRESHOLD, `压缩前 ${d3Before} 应确实超阈值`);
  assert.ok(d3After <= COMPACT_THRESHOLD, `压缩后 ${d3After} 应 <= 窗口阈值`);
  // 摘要调用的 usage 必须计入会话：每次摘要至少贡献 100 input token。
  const d3SummaryCalls = summaryCount() - summaryBeforeD3;
  assert.ok(d3SummaryCalls >= 1, "D3 至少应发生一次摘要调用");
  assert.ok(
    d3Session.header.usage.input >= d3SummaryCalls * 100,
    `摘要 usage 应计入会话（input=${d3Session.header.usage.input}, 摘要调用=${d3SummaryCalls}）`,
  );
  console.log(
    `✓ D3 双读压缩：tokensBefore=${d3Before} tokensAfter=${d3After}，JSONL 内容估算=${d3ContentTokens}`,
  );

  // D3 续跑：--resume 的首个请求体必须落在窗口内（旧缺陷下会直接超窗）。
  const d3Id = basename(d3SessionFile, ".jsonl");
  const requestCountBeforeResume = requests.length;
  const d3Resume = await runCli(
    ["--yes", "--resume", d3Id, "--max-turns", "1", "RESUME 继续"],
    compactEnv,
    workspace,
  );
  assert.equal(d3Resume.code, 0, d3Resume.stderr);
  const resumeRequests = requests.slice(requestCountBeforeResume);
  const firstResumeBody =
    resumeRequests.find((body) => JSON.stringify(body).includes("RESUME 继续")) ?? resumeRequests[0];
  assert.ok(firstResumeBody, "resume 应至少发出一次请求");
  const requestTokens = Math.ceil(JSON.stringify(firstResumeBody.messages).length / 4);
  assert.ok(
    requestTokens <= COMPACT_WINDOW,
    `resume 首请求 chars/4=${requestTokens} 应 <= 窗口 ${COMPACT_WINDOW}`,
  );
  console.log(`✓ D3 --resume 首请求 chars/4=${requestTokens}，落在 ${COMPACT_WINDOW} 窗口内`);

  // D3 /cost：恢复后累计用量非零，且包含摘要 usage（摘要每次至少 100 input token）。
  const d3Cost = await runCliStaged(
    ["--yes", "--resume", d3Id],
    compactEnv,
    workspace,
    [
      { delayMs: 0, data: "/cost\n" },
      { delayMs: 300, data: "/exit\n" },
    ],
  );
  assert.equal(d3Cost.code, 0, d3Cost.stderr);
  const d3CostLine = d3Cost.stdout.match(/累计用量：token (\d+).*?成本 \$([\d.]+)/);
  assert.ok(d3CostLine, `D3 /cost 应输出累计用量：${d3Cost.stdout}`);
  assert.ok(Number(d3CostLine[1]) > 0, "D3 /cost token 必须非零");
  assert.ok(Number(d3CostLine[2]) > 0, "D3 /cost 成本必须非零（含摘要调用）");
  console.log(`✓ D3 /cost 非零：token=${d3CostLine[1]} 成本=$${d3CostLine[2]}`);

  // C-M2-2：REPL /cost 展示累计 token 与成本（cost 必须非零）
  const repl = await runCliStaged(
    ["--yes"],
    baseEnv,
    workspace,
    [
      { delayMs: 0, data: "TEXT 你好\n" },
      { delayMs: 800, data: "/cost\n" },
      { delayMs: 300, data: "/exit\n" },
    ],
  );
  assert.equal(repl.code, 0, repl.stderr);
  assert.match(repl.stdout, /累计用量：token \d+/);
  const costMatch = repl.stdout.match(/成本 \$(\d+\.\d+)/);
  assert.ok(costMatch, `应输出成本金额：${repl.stdout}`);
  assert.ok(Number(costMatch[1]) > 0, "配置费率后 /cost 成本必须非零");
  console.log("✓ C-M2-2 /cost 展示非零累计成本");

  // P3-12：管道一次性输入多行时，run 必须串行而不是并发
  const piped = await runCli(
    ["--yes"],
    baseEnv,
    workspace,
    "TEXT 管道一\nTEXT 管道二\n/exit\n",
  );
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal((piped.stdout.match(/已完成。/g) ?? []).length, 2, "两行输入都应各完成一轮");
  const pipedSession = readSession(findSessionByTitle(home, "TEXT 管道一"));
  assert.deepEqual(
    pipedSession.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
    "两轮 run 必须按序写入同一会话",
  );
  console.log("✓ P3-12 管道多行输入串行执行");

  // P1-3：provider 400 打印错误、单次模式退出码非零、JSONL 不写入空 assistant
  const providerError = await runCli(["--yes", "ERROR 测试"], baseEnv, workspace);
  assert.equal(providerError.code, 1, `provider 错误应非零退出，实际 ${providerError.code}`);
  assert.match(providerError.stdout + providerError.stderr, /模型调用失败/);
  const errorSession = readSession(findSessionByTitle(home, "ERROR 测试"));
  assert.equal(errorSession.messages.some((message) => message.role === "assistant"), false);
  assert.equal(errorSession.messages[0].role, "user");
  console.log("✓ P1-3 provider 错误不静默、退出码 1、错误 assistant 不落盘");

  // P3-9：缺失取值只告警，不吞掉 --help
  const missingValue = await runCli(["--max-turns", "--help"], baseEnv, workspace);
  assert.equal(missingValue.code, 0, missingValue.stderr);
  assert.match(missingValue.stderr, /--max-turns 缺少取值/);
  assert.match(missingValue.stdout, /用法：/);

  const invalidNumber = await runCli(["--max-turns=abc", "--help"], baseEnv, workspace);
  assert.equal(invalidNumber.code, 0, invalidNumber.stderr);
  assert.match(invalidNumber.stderr, /--max-turns 需要正整数/);
  console.log("✓ P3-9 --key=value / 缺失取值 / 非法数字");

  console.log("\n全部 M2 端到端用例通过（本地桩模型，无真实 key）。");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
