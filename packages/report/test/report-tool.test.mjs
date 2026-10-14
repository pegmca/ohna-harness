import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createDataSourceRuntime, createDeterministicMockEmbeddingClient } from "@aiagent/rag";
import { createReportTool } from "../dist/index.js";

/**
 * 内存 ArtifactStorage：与 local adapter 同端口，key 由「服务端」随机生成。
 *
 * @returns {import("@aiagent/report").ArtifactStorage & { store: Map<string, Uint8Array> }} 内存存储。
 */
function createMemoryArtifactStorage() {
  const store = new Map();
  return {
    store,
    async writePdf(bytes) {
      const key = `ab/${crypto.randomUUID()}.pdf`;
      store.set(key, new Uint8Array(bytes));
      return {
        provider: "local",
        key,
        sizeBytes: bytes.byteLength,
        checksumSha256: createHash("sha256").update(bytes).digest("hex")
      };
    },
    async readPdf(key) {
      const bytes = store.get(key);
      if (!bytes) throw new Error("missing pdf");
      return bytes;
    },
    async deletePdf(key) {
      store.delete(key);
    }
  };
}

/** 内存 workflow/artifact repositories，语义对齐 packages/report 的端口。 */
function createMemoryReportRepositories() {
  const workflows = new Map();
  const artifacts = new Map();
  return {
    workflowRepository: {
      async save(value) { workflows.set(`${value.context.userId}:${value.run.runId}`, structuredClone(value)); },
      async findById(userId, workflowRunId) { return workflows.get(`${userId}:${workflowRunId}`); }
    },
    artifactRepository: {
      async save(value) {
        artifacts.set(`${value.userId}:${value.artifact.artifactId}`, structuredClone(value));
        return value;
      },
      async findById(userId, artifactId) { return artifacts.get(`${userId}:${artifactId}`); },
      async softDelete() { return false; }
    }
  };
}

const DEMO_DOCUMENT = {
  source: "demo/annual-report",
  fileName: "000001-annual-report.md",
  contentType: "text/markdown",
  content: `# 000001.SZ 2024 年年度报告摘要

## 盈利能力
2024 年，公司实现营业收入 1646 亿元，同比下降 3.2%；归属于股东的净利润 397 亿元，同比增长 2.1%。加权平均净资产收益率（ROE）为 10.5%，同比下降 0.4 个百分点。

## 资产质量
截至 2024 年末，公司不良贷款率为 1.05%，较上年末下降 0.01 个百分点。拨备覆盖率保持充足，资产质量整体保持稳定。
`
};

/**
 * 创建测试用 RAG runtime。
 *
 * embedding client 已无生产默认值，这里显式注入 deterministic mock 测试替身（非生产配置），
 * 否则 ingest 会直接返回 embedding_provider_disabled。
 *
 * @returns {import("@aiagent/rag").DataSourceRuntime} 已配置测试替身的 runtime。
 */
function createTestDataSourceRuntime() {
  return createDataSourceRuntime({ embeddingClient: createDeterministicMockEmbeddingClient() });
}

/** 装配一套带预置年报证据的 generate_report 工具与观测收集器。 */
async function createToolHarness() {
  const dataSourceRuntime = createTestDataSourceRuntime();
  const ingest = await dataSourceRuntime.ingest(DEMO_DOCUMENT);
  assert.equal(ingest.ok, true);
  const repos = createMemoryReportRepositories();
  const storage = createMemoryArtifactStorage();
  const events = [];
  const tool = createReportTool({
    dataSourceRuntime,
    workflowRepository: repos.workflowRepository,
    artifactRepository: repos.artifactRepository,
    artifactStorage: storage,
    ownerUserId: "user-tool-test",
    conversationId: "conv-tool-test",
    agentRunId: "run-tool-test",
    sink: async (event) => { events.push(event); }
  });
  return { tool, repos, storage, events };
}

test("generate_report runs full workflow, persists artifacts and publishes a real PDF", async () => {
  const { tool, repos, storage, events } = await createToolHarness();
  assert.equal(tool.name, "generate_report");

  const result = await tool.execute("call_1", { subject: "000001.SZ", scope: "最近两年" });

  // 工具结果：content 含草稿摘要、artifactId 与 PDF 下载链接；details 带完整引用。
  const text = result.content[0].text;
  const workflowRunId = result.details.workflowRunId;
  const artifactId = `artifact_${workflowRunId}`;
  assert.match(text, /研究报告已生成/);
  assert.match(text, new RegExp(artifactId));
  assert.match(text, /PDF 下载：\/api\/report-artifacts\/.+\/download/);
  assert.equal(result.details.artifactId, artifactId);
  assert.equal(result.details.pdfStatus, "ready");
  assert.equal(result.details.plan.status, "ready");
  assert.equal(result.details.plan.subject, "000001.SZ");
  assert.ok(result.details.citations.length > 0);

  // 事件流：六个节点各 running+succeeded 共 12 个 workflow_node；pdf_export 时序 queued → not_implemented → ready。
  const nodeEvents = events.filter((event) => event.type === "workflow_node");
  assert.equal(nodeEvents.length, 12);
  const succeededNodeIds = new Set(
    nodeEvents.filter((event) => event.payload.status === "succeeded").map((event) => event.payload.nodeId)
  );
  assert.deepEqual(
    [...succeededNodeIds].sort(),
    ["analyzer", "citation_verifier", "data_collector", "pdf_exporter", "report_writer", "risk_checker"].sort()
  );
  const pdfStatuses = events.filter((event) => event.type === "pdf_export").map((event) => event.payload.status);
  assert.deepEqual(pdfStatuses, ["queued", "not_implemented", "ready"]);

  // workflow 持久化：六个节点全部成功，归属上下文正确。
  const workflow = await repos.workflowRepository.findById("user-tool-test", workflowRunId);
  assert.ok(workflow);
  assert.equal(workflow.run.status, "succeeded");
  assert.equal(workflow.run.nodes.every((node) => node.status === "succeeded"), true);
  assert.equal(workflow.context.conversationId, "conv-tool-test");
  assert.equal(workflow.context.agentRunId, "run-tool-test");

  // artifact 持久化：PDF 已发布，storage 可读出合法 PDF bytes。
  const record = await repos.artifactRepository.findById("user-tool-test", artifactId);
  assert.ok(record);
  assert.equal(record.artifact.status, "pdf_ready");
  assert.ok(record.storageKey);
  const bytes = await storage.readPdf(record.storageKey);
  assert.match(new TextDecoder().decode(bytes), /^%PDF-1\.4/);
});

test("generate_report propagates persistence failures as structured tool errors", async () => {
  const dataSourceRuntime = createTestDataSourceRuntime();
  await dataSourceRuntime.ingest(DEMO_DOCUMENT);
  const repos = createMemoryReportRepositories();
  repos.workflowRepository.save = async () => { throw new Error("db down"); };
  const tool = createReportTool({
    dataSourceRuntime,
    workflowRepository: repos.workflowRepository,
    artifactRepository: repos.artifactRepository,
    artifactStorage: createMemoryArtifactStorage(),
    ownerUserId: "user-tool-test",
    conversationId: "conv-tool-test",
    agentRunId: "run-tool-test",
    sink: async () => undefined
  });

  await assert.rejects(() => tool.execute("call_2", { subject: "000001.SZ" }), /db down/);
});
