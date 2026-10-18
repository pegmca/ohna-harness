#!/usr/bin/env node
/**
 * ohna-cli M3 + --web 端到端验证（无需真实 API key）。
 *
 * 复用 verify-ohna-m2 的本地 OpenAI 兼容桩思路驱动真实 CLI 进程，自动覆盖：
 * - C-M3-1 slash 命令：/help /model /cost /tools /resume /compact 各自生效且不触发模型请求；
 * - C-M3-2 diff 渲染：edit 前终端打印 unified diff（- / + 行），确认后落盘；
 * - C-M3-3 输出折叠：超长 bash 输出只显示头尾 + 省略提示；
 * - C-M3-4 MCP 接入：--mcp 指向 packages/mcp/dist/stdio.js，/tools 出现发现工具；
 *   adapter 的 <untrusted_context> 封装以产物代码断言确认（代码审查的自动化形态）；
 * - C-M3-6 --web 托管：ohna --web 启动 → /api/health=local → HTTP POST /api/runs
 *   → 终端 stdout 渲染同一 run（会话级订阅生效）→ /exit 干净退出；
 * - L3-1 /resume 切换会话；L3-2 /cost 累计；L3-3 serve compaction 由
 *   packages/serve/test/compaction.test.mjs 覆盖（此处输出提示）。
 *
 * 运行：pnpm --filter @aiagent/mcp build && node test/verify-ohna-m3.mjs
 * 所有会话写入临时 HOME，绝不触碰真实 ~/.ohna。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "apps/ohna-cli/dist/index.js");
const mcpStdioPath = join(repoRoot, "packages/mcp/dist/stdio.js");

assert.ok(existsSync(cliPath), "请先 pnpm --filter @aiagent/ohna-cli build");
assert.ok(existsSync(mcpStdioPath), "请先 pnpm --filter @aiagent/mcp build");

/**
 * 把 chunk 列表编码为 SSE 响应。
 *
 * @param {object[]} chunks chat completion chunk 列表。
 * @returns {string} SSE 文本。
 */
function sseBody(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * 生成一次工具调用响应。
 *
 * @param {string} id 响应 id。
 * @param {string} name 工具名。
 * @param {object} args 工具参数。
 * @returns {string} SSE 文本。
 */
function toolCallBody(id, name, args) {
  return sseBody([
    {
      id,
      model: "stub",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id, model: "stub", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
  ]);
}

/**
 * 生成一次纯文本响应。
 *
 * @param {string} id 响应 id。
 * @param {string} text 文本。
 * @returns {string} SSE 文本。
 */
function textBody(id, text) {
  return sseBody([
    { id, model: "stub", choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
  ]);
}

/**
 * 启动桩模型服务：按最后一条 user 文本决定响应。
 *
 * @returns {Promise<{server: object, baseUrl: string, requestCount: () => number}>}
 */
async function startStubServer() {
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const systemText = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
      const hasToolMessage = messages.some((m) => m.role === "tool");

      // 摘要调用（serve run 前压缩 / CLI 落盘压缩共用文案）。
      if (systemText.includes("上下文压缩器")) {
        requests += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(textBody("stub-summary", "这是历史摘要"));
        return;
      }

      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });

      if (userText.includes("EDIT") && !hasToolMessage) {
        res.end(toolCallBody("stub-edit", "edit", {
          path: "demo.txt",
          oldText: "hello",
          newText: "HELLO-M3",
        }));
        return;
      }
      if (userText.includes("LONGOUT") && !hasToolMessage) {
        // 输出 200 行：超过折叠阈值（40 行 / 1200 字符），中段必须被省略。
        const command = 'node -e "for(let i=0;i<200;i++)console.log(\'out-\'+i)"';
        res.end(toolCallBody("stub-bash", "bash", { command }));
        return;
      }
      res.end(textBody("stub-text", `已完成：${userText.slice(0, 20)}`));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestCount: () => requests };
}

/**
 * 运行 CLI 子进程（一次性输入）。
 *
 * @param {string[]} args 参数。
 * @param {object} env 环境变量。
 * @param {string} cwd 工作区。
 * @param {string} [input] stdin 内容。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCli(args, env, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

/**
 * 运行 CLI 子进程（句柄式：供 --web 用例分阶段写入并轮询 stdout）。
 *
 * @param {string[]} args 参数。
 * @param {object} env 环境变量。
 * @param {string} cwd 工作区。
 * @returns {{child: object, getStdout: () => string, write: (s: string) => void, closed: Promise<number>}}
 */
function spawnCli(args, env, cwd) {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolve) => child.on("close", resolve));
  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    write: (text) => child.stdin.write(text),
    endInput: () => child.stdin.end(),
    closed,
  };
}

const root = mkdtempSync(join(realpathSync(tmpdir()), "ohna-m3-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "demo.txt"), "hello\n", "utf8");

const { server, baseUrl, requestCount } = await startStubServer();
const baseEnv = {
  HOME: home,
  AIAGENT_LLM_API_KEY_DEEPSEEK: "stub-key",
  AIAGENT_LLM_BASE_URL_DEEPSEEK: baseUrl,
  AIAGENT_LLM_MODEL_DEEPSEEK: "stub",
  AIAGENT_LLM_COST_IN_DEEPSEEK: "1",
  AIAGENT_LLM_COST_OUT_DEEPSEEK: "1",
};

try {
  // ---- C-M3-1：slash 命令不触发模型请求 ----
  {
    const before = requestCount();
    const result = await runCli(
      ["--mode", "coding"],
      baseEnv,
      workspace,
      "/help\n/model\n/cost\n/tools\n/resume\n/compact\n/exit\n",
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /会话内命令：/, "/help 应输出命令列表");
    assert.match(result.stdout, /当前模型：/, "/model 无参应列出当前模型");
    assert.match(result.stdout, /可用 profile：/, "/model 无参应列出可用 profile");
    assert.match(result.stdout, /累计用量：暂无/, "/cost 无用量应明确说明");
    assert.match(result.stdout, /▸? ?read/, "/tools 应列出 read 等工具");
    assert.match(result.stdout, /暂无历史会话|最近会话/, "/resume 无参应列出会话或提示为空");
    assert.match(result.stdout, /当前会话没有历史消息，无需压缩/, "/compact 空会话应说明");
    assert.equal(requestCount() - before, 0, "slash 命令不得触发任何模型请求");
    console.log("✓ C-M3-1 slash 命令生效且不消耗 token（stub 收到 0 次模型调用）");
  }

  // ---- C-M3-2：edit 前打印 unified diff，--yes 确认后落盘 ----
  {
    const result = await runCli(["--mode", "coding", "--yes", "EDIT 请编辑 demo.txt"], baseEnv, workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /-hello/, "diff 应包含删除行");
    assert.match(result.stdout, /\+HELLO-M3/, "diff 应包含新增行");
    assert.match(result.stdout, /@@ -1 \+1 @@/, "diff 应包含 hunk 头（单行修改省略 ,1）");
    assert.equal(readFileSync(join(workspace, "demo.txt"), "utf8"), "HELLO-M3\n", "确认后文件应落盘");
    console.log("✓ C-M3-2 edit 前打印 unified diff，--yes 后落盘");
  }

  // ---- C-M3-3：超长 bash 输出折叠 ----
  {
    const result = await runCli(["--mode", "coding", "--yes", "LONGOUT 长输出"], baseEnv, workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /输出已折叠，省略 \d+ 行/);
    assert.match(result.stdout, /out-0/, "应保留头部");
    assert.doesNotMatch(result.stdout, /out-150/, "中段内容不应出现");
    console.log("✓ C-M3-3 超长 bash 输出被折叠（只显示头尾 + 省略提示）");
  }

  // ---- C-M3-4：--mcp 接入内置金融 MCP server ----
  {
    const mcpConfigPath = join(root, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({
      servers: [{ name: "finance", command: process.execPath, args: [mcpStdioPath] }],
    }));
    const result = await runCli(["--mode", "coding", "--mcp", mcpConfigPath], baseEnv, workspace, "/tools\n/exit\n");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /search_filings（MCP）/, "/tools 应列出 MCP 发现的工具并标注来源");
    assert.match(result.stderr, /\[mcp\] 已接入 server "finance"/, "发现事件应写 stderr 单行日志");
    // 代码审查的自动化形态：确认 adapter 产物确实做 <untrusted_context> 封装。
    const adapterDist = readFileSync(join(repoRoot, "packages/mcp/dist/tool-adapter.js"), "utf8");
    assert.match(adapterDist, /untrusted_context/, "tool-adapter 产物应包含 untrusted_context 封装");
    console.log("✓ C-M3-4 --mcp 工具进入注册表并标注来源；adapter 输出经 <untrusted_context> 封装");
  }

  // ---- L3-1：/resume 无参列表 + 带参切换 ----
  {
    // 先造一个会话。
    await runCli(["--mode", "coding", "--yes", "TEXT 第一会话"], baseEnv, workspace);
    const sessionsDir = join(home, ".ohna", "sessions");
    const sessionId = readdirSync(sessionsDir).find((name) => {
      const raw = readFileSync(join(sessionsDir, name), "utf8");
      return raw.includes("第一会话");
    }).slice(0, -".jsonl".length);

    const result = await runCli(
      ["--mode", "coding", "--yes"],
      baseEnv,
      workspace,
      `/resume\n/resume ${sessionId}\nTEXT 切换后续跑\n/exit\n`,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /最近会话/, "/resume 无参应列出最近会话");
    assert.match(result.stdout, new RegExp(`已切换到会话 ${sessionId}`), "带参应切换会话");
    assert.match(result.stdout, /已完成：TEXT 切换后续跑/, "切换后应能接续对话");
    // 原会话文件应增长（历史被载入并继续落盘）。
    const raw = readFileSync(join(sessionsDir, `${sessionId}.jsonl`), "utf8");
    assert.ok(raw.includes("TEXT 第一会话") && raw.includes("切换后续跑"), "原会话应包含切换前后的消息");
    console.log("✓ L3-1 /resume 切换会话并载入历史继续落盘");
  }

  // ---- L3-2：/cost 累计 ----
  {
    const result = await runCli(
      ["--mode", "coding", "--yes"],
      baseEnv,
      workspace,
      "TEXT 成本\n/cost\n/exit\n",
    );
    assert.equal(result.code, 0, result.stderr);
    const costLine = result.stdout.match(/累计用量：token (\d+).*?成本 \$(\d+\.\d+)/);
    assert.ok(costLine, `/cost 应输出累计：${result.stdout}`);
    assert.ok(Number(costLine[1]) > 0 && Number(costLine[2]) > 0);
    console.log("✓ L3-2 /cost 展示非零累计 token 与成本");
  }

  // ---- C-M3-6：--web 进程内托管 ----
  {
    const webPort = 24680 + Math.floor(Math.random() * 1000);
    const session = spawnCli(
      ["--web", workspace, "--no-open", "--web-port", String(webPort)],
      baseEnv,
      workspace,
    );

    // 等待 health 就绪。
    let health = null;
    for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${webPort}/api/health`);
        if (response.ok) health = await response.json();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(health, "--web 应启动 HTTP 服务");
    assert.equal(health.mode, "local", "/api/health 应返回 mode=local");

    // 终端创建的会话必须出现在浏览器侧会话列表。
    const conversationsResponse = await fetch(`http://127.0.0.1:${webPort}/api/conversations`);
    const conversations = (await conversationsResponse.json()).data.items;
    const shared = conversations.find((item) => item.title === "终端会话");
    assert.ok(shared, "终端创建的会话应出现在 GET /api/conversations");

    // 浏览器侧发 run → 终端渲染同一 run（会话级订阅）。
    const runResponse = await fetch(`http://127.0.0.1:${webPort}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "MARK 浏览器直连 XYZWEBXYZ",
        conversationId: shared.conversationId,
        mode: "auto",
        source: "composer",
      }),
    });
    assert.equal(runResponse.status, 202, "POST /api/runs 应返回 202");

    // 轮询终端 stdout 直到出现该 run 的渲染。
    let rendered = false;
    for (let attempt = 0; attempt < 150 && !rendered; attempt += 1) {
      rendered = session.getStdout().includes("XYZWEBXYZ");
      if (!rendered) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(rendered, "终端 stdout 应渲染浏览器发的同一 run（会话级订阅生效）");

    // /exit 干净退出（end stdin：管道场景下 stdin 句柄需要显式释放，事件循环才能排空）。
    session.write("/exit\n");
    session.endInput();
    const exitCode = await Promise.race([
      session.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("--web 未在 10s 内退出")), 10_000)),
    ]);
    assert.equal(exitCode, 0, "--web 应干净退出");
    console.log("✓ C-M3-6 --web 托管：health=local、会话共享、浏览器 run 终端实时渲染、/exit 干净退出");
  }

  console.log("\n✓ L3-3 serve compaction（run 前压缩、compaction 消息落盘、二次 run 不超窗）由 packages/serve/test/compaction.test.mjs 覆盖。");
  console.log("\n全部 M3 + --web 端到端用例通过（本地桩模型，无真实 key）。");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
