/**
 * Golden Studio serve 生命周期与静态托管进程测试。
 *
 * 使用隔离工作区、随机端口和真实子进程验证启动输出、同源 API/SPA、
 * CSS 内容类型、结构化启动错误与 SIGTERM 收尾。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeGolden,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

/** 包根。 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** CLI 入口。 */
const CLI_ENTRY = join(PACKAGE_ROOT, "src", "cli", "main.ts");
/** 测试子进程。 */
const children = new Set();

after(() => {
  for (const child of children) child.kill("SIGKILL");
  cleanupWorkflowFixtures();
});

test("serve 启动真实 HTTP/SPA，输出实际 URL 并在 SIGTERM 后关闭", async () => {
  const fixture = makeWorkflowConfig();
  const pdfPath = "600000.SH/annual/2025.pdf";
  writeManifest(fixture, [
    {
      ticker: "600000.SH",
      report_type: "annual",
      period: "2025",
      file_path: pdfPath
    }
  ]);
  writePdf(fixture, pdfPath, "Revenue 100. ".repeat(30));
  writeGolden(fixture, []);
  const staticDir = join(fixture.workspaceRoot, "static");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(
    join(staticDir, "index.html"),
    "<!doctype html><title>Golden Studio Test</title><div id=root></div>"
  );
  writeFileSync(join(staticDir, "assets", "app.css"), "body { color: red; }");

  const child = launch([
    "serve",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot
  ], {
    GOLDEN_STUDIO_PORT: "0",
    GOLDEN_STUDIO_STATIC_DIR: staticDir
  });
  const url = await waitForUrl(child);
  const base = url.toString();

  try {
    const api = await fetch(new URL("/api/settings", base));
    assert.equal(api.status, 200);
    const settings = await api.json();
    assert.equal(settings.ok, true);
    assert.equal(settings.data.workspaceRoot, realpathSync(fixture.workspaceRoot));

    const spa = await fetch(new URL("/golden", base));
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /Golden Studio Test/);

    const css = await fetch(new URL("/assets/app.css", base));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /^text\/css/);

    const missingApi = await fetch(new URL("/api/not-found", base));
    assert.equal(missingApi.status, 404);
    assert.equal((await missingApi.json()).error.code, "not_found");
  } finally {
    child.kill("SIGTERM");
  }

  const exit = await childExit(child);
  assert.equal(exit.code, 0, child.stderrText);
  assert.equal(exit.signal, null);
  children.delete(child);
  await assertRejectsFetch(base, url.hostname);
});

test("serve 在工作区失败时输出唯一稳定 JSON 且不监听", async () => {
  const fixture = makeWorkflowConfig();
  rmSync(fixture.manifestPath, { force: true });
  const child = launch([
    "serve",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--json"
  ], { GOLDEN_STUDIO_PORT: "0" });
  const exit = await childExit(child);

  assert.equal(exit.code, 1);
  assert.equal(exit.stderr, "");
  const output = JSON.parse(exit.stdout.trim());
  assert.deepEqual(
    {
      ok: output.ok,
      command: output.command,
      error: output.error,
      stage: output.details.stage
    },
    {
      ok: false,
      command: "serve",
      error: "serve_startup_failed",
      stage: "workspace"
    }
  );
  assert.equal(exit.stdout.trim().split("\n").length, 1);
  children.delete(child);
});

test("serve 拒绝非法端口时保留稳定闭包错误", async () => {
  const fixture = makeWorkflowConfig();
  writeManifest(fixture, []);
  writeGolden(fixture, []);
  const child = launch([
    "serve",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--json"
  ], {
    GOLDEN_STUDIO_PORT: "not-a-port"
  });
  const exit = await childExit(child);

  assert.equal(exit.code, 1);
  assert.equal(exit.stderr, "");
  const output = JSON.parse(exit.stdout.trim());
  assert.equal(output.error, "serve_startup_failed");
  assert.deepEqual(output.details, {
    stage: "listen",
    variable: "GOLDEN_STUDIO_PORT"
  });
  children.delete(child);
});

test("serve 在构建产物缺失时拒绝启动并报告静态资源阶段", async () => {
  const fixture = makeWorkflowConfig();
  writeManifest(fixture, []);
  writeGolden(fixture, [makeGoldenCase()]);
  const child = launch([
    "serve",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot
  ], {
    GOLDEN_STUDIO_PORT: "0",
    GOLDEN_STUDIO_STATIC_DIR: join(fixture.workspaceRoot, "missing-static")
  });
  const url = await waitForUrl(child);
  const response = await fetch(url);
  assert.equal(response.status, 503);
  child.kill("SIGTERM");
  const exit = await childExit(child);
  assert.equal(exit.code, 0, exit.stderr);
  children.delete(child);
});

/**
 * 启动真实 CLI 子进程。
 *
 * @param argv CLI 参数。
 * @param env 额外环境变量。
 * @returns 子进程状态。
 */
function launch(argv, env = {}) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI_ENTRY, ...argv],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        GOLDEN_WORKSPACE_ROOT: "",
        FINANCE_CORPUS_ROOT: "",
        ...env
      }
    }
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (chunk) => {
    child.stdoutText += chunk;
  });
  child.stderr.on("data", (chunk) => {
    child.stderrText += chunk;
  });
  children.add(child);
  return child;
}

/**
 * 从人类输出中读取实际监听 URL。
 *
 * @param child 子进程状态。
 * @returns 监听 URL。
 */
async function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`serve did not print its URL: ${child.stderrText}`)),
      10_000
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `serve exited before URL (code=${code}): ${child.stdoutText}${child.stderrText}`
        )
      );
    });
    const inspect = () => {
      const match = /Golden Studio listening at (http:\/\/[^\s]+)/u.exec(
        child.stdoutText
      );
      if (!match) return;
      child.stdout.off("data", inspect);
      clearTimeout(timeout);
      resolve(new URL(match[1]));
    };
    child.stdout.on("data", inspect);
    inspect();
  });
}

/**
 * 等待子进程退出。
 *
 * @param child 子进程状态。
 * @returns 退出码、信号与输出。
 */
function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
      stdout: child.stdoutText,
      stderr: child.stderrText
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve did not exit: ${child.stderrText}`));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        stdout: child.stdoutText,
        stderr: child.stderrText
      });
    });
  });
}

/**
 * 断言关闭后连接被拒绝。
 *
 * @param base 原监听 URL。
 * @param host 监听主机。
 */
async function assertRejectsFetch(base, host) {
  assert.equal(host, "127.0.0.1");
  await assert.rejects(fetch(new URL("/api/settings", base)));
}
