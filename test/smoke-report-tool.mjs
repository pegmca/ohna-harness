/**
 * 手工冒烟（阶段 5 report/workflow 回迁）：内存 adapter 起 API server + MockModel，
 * 走「用户显式要研报 → 模型自主调用 generate_report 工具 → 六节点 workflow → 真实 PDF」全链路。
 *
 * 运行方式：先 pnpm --filter @aiagent/finance-api build（依赖包已构建），再 node test/smoke-report-tool.mjs。
 * 与 smoke-rag-grounding.mjs 的差异：本脚本不需要 PostgreSQL，全部事实源为内存 adapter。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/finance-api/dist/index.js";
import { createInMemoryApiTestRuntime } from "../apps/finance-api/dist/adapters/in-memory-test-runtime.js";
import { createLocalArtifactStorage } from "../packages/report/dist/index.js";

const DEMO_DOCUMENT = {
  source: "smoke/annual-report",
  fileName: "000001-annual-report.md",
  contentType: "text/markdown",
  content: `# 000001.SZ 2024 年年度报告摘要

## 盈利能力
2024 年，公司实现营业收入 1646 亿元，同比下降 3.2%；归属于股东的净利润 397 亿元，同比增长 2.1%。加权平均净资产收益率（ROE）为 10.5%，同比下降 0.4 个百分点。

## 资产质量
截至 2024 年末，公司不良贷款率为 1.05%，较上年末下降 0.01 个百分点。拨备覆盖率保持充足，资产质量整体保持稳定。
`
};

async function main() {
  const storageRoot = await mkdtemp(join(tmpdir(), "aiagent-report-smoke-"));
  const runtime = createInMemoryApiTestRuntime();
  const app = createApiServer({
    ...runtime,
    artifactStorage: createLocalArtifactStorage(storageRoot),
    requireIdentity: true
  });
  try {
    // 1. 身份 bootstrap + 创建会话
    const boot = await app.inject({
      method: "POST", url: "/api/identity/bootstrap",
      payload: { visitorId: `smoke_report_${Date.now()}`, fingerprintVersion: "smoke-v1" }
    });
    assert.equal(boot.statusCode, 200);
    const cookie = boot.headers["set-cookie"].split(";")[0];
    const conv = await app.inject({
      method: "POST", url: "/api/conversations", headers: { cookie },
      payload: { title: "report tool smoke" }
    });
    assert.equal(conv.statusCode, 201);
    const conversationId = conv.json().data.conversationId;
    console.log("conversation:", conversationId);

    // 2. 预置年报证据（与 report 工具共用同一内存 RAG runtime）
    const ingest = await runtime.dataSourceRuntime.ingest(DEMO_DOCUMENT);
    assert.equal(ingest.ok, true, "年报证据 ingest 失败");
    console.log("evidence ingested");

    // 3. 创建 report run：metadata hint=report + MockModel 按研报关键词自主调用 generate_report
    const accepted = (await app.inject({
      method: "POST", url: "/api/runs", headers: { cookie },
      payload: {
        message: "帮我生成 000001.SZ 的研报",
        conversationId,
        mode: "report",
        source: "report_button",
        metadata: { hint: "report" }
      }
    })).json().data;
    console.log("run created:", accepted.runId);

    // 4. 等待终态
    let snapshot;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await app.inject({ method: "GET", url: accepted.snapshotUrl, headers: { cookie } });
      snapshot = response.json().data;
      if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(snapshot.status, "completed", `run 未完成: ${snapshot.status}`);
    console.log("run terminal status:", snapshot.status);

    // 5. 事件流断言：6 个节点各有 succeeded 的 workflow_node，pdf_export 收尾为 ready
    const eventsResponse = await app.inject({
      method: "GET", url: `${accepted.eventsUrl}?afterSequence=0`, headers: { cookie }
    });
    const streamEvents = eventsResponse.body.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const nodeEvents = streamEvents.filter((event) => event.type === "workflow_node");
    const succeededNodeIds = new Set(
      nodeEvents.filter((event) => event.payload.status === "succeeded").map((event) => event.payload.nodeId)
    );
    assert.equal(succeededNodeIds.size, 6, `应有 6 个成功节点，实际: ${[...succeededNodeIds].join(",")}`);
    const pdfStatuses = streamEvents.filter((event) => event.type === "pdf_export").map((event) => event.payload.status);
    assert.ok(pdfStatuses.includes("queued"), "pdf_export 应含 queued");
    assert.equal(pdfStatuses.at(-1), "ready", `pdf_export 终态应为 ready: ${pdfStatuses.join(",")}`);
    const workflowRunId = streamEvents.find((event) => event.type === "pdf_export").payload.workflowRunId;
    console.log("workflow_node succeeded nodes:", [...succeededNodeIds].sort().join(","));
    console.log("pdf_export statuses:", pdfStatuses.join(" → "));

    // 6. 消息断言：generate_report 的 ToolResultMessage 落库
    const messages = (await app.inject({
      method: "GET", url: `/api/conversations/${conversationId}/messages?limit=100`, headers: { cookie }
    })).json().data.items;
    const toolResult = messages.find((message) => message.role === "toolResult" && message.content.toolName === "generate_report");
    assert.ok(toolResult, "messages 应有 generate_report 的 ToolResultMessage");
    assert.equal(toolResult.content.isError, false, "generate_report 不应失败");
    const artifactId = toolResult.content.details.artifactId;
    console.log("toolResult artifactId:", artifactId);

    // 7. 读取路由断言：workflow 快照与 artifact、PDF 下载可用
    const workflow = await app.inject({
      method: "GET", url: `/api/report-workflows/${workflowRunId}`, headers: { cookie }
    });
    assert.equal(workflow.statusCode, 200, "GET /api/report-workflows/:runId 应可用");
    assert.equal(workflow.json().data.run.status, "succeeded");
    assert.equal(workflow.json().data.artifact.status, "pdf_ready");

    const artifact = await app.inject({
      method: "GET", url: `/api/report-artifacts/${artifactId}`, headers: { cookie }
    });
    assert.equal(artifact.statusCode, 200, "GET /api/report-artifacts/:artifactId 应可用");
    assert.ok(artifact.json().data.pdfExport.downloadUrl, "artifact 应含 PDF 下载 URL");

    const download = await app.inject({
      method: "GET", url: `/api/report-artifacts/${artifactId}/download`, headers: { cookie }
    });
    assert.equal(download.statusCode, 200, "PDF 下载应可用");
    assert.equal(download.headers["content-type"], "application/pdf");
    assert.ok(download.rawPayload.slice(0, 8).toString("latin1").startsWith("%PDF-1."), "下载内容应为合法 PDF");
    console.log("pdf bytes:", download.rawPayload.byteLength);

    console.log("\n✅ report tool 冒烟通过");
  } finally {
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
