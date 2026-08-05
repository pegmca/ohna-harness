import { createDataSourceRuntime } from "@aiagent/rag";
import { createReportTool, createLocalArtifactStorage } from "@aiagent/report";
import fs from "node:fs/promises";

const runtime = createDataSourceRuntime();
const artifactStorage = createLocalArtifactStorage({ baseDir: "/tmp/repro-artifacts" });
await fs.mkdir("/tmp/repro-artifacts", { recursive: true });

const workflowRepo = {
  save: async () => {}
};
const artifactRepo = {
  save: async (record) => record.artifact,
  findById: async () => undefined
};

async function runReport(conversationId, runId) {
  const events = [];
  const tool = createReportTool({
    dataSourceRuntime: runtime,
    workflowRepository: workflowRepo,
    artifactRepository: artifactRepo,
    artifactStorage,
    ownerUserId: "user1",
    conversationId,
    agentRunId: runId,
    sink: async (event) => {
      events.push(event);
    }
  });
  try {
    const result = await tool.execute("call1", { subject: "000001.SZ" });
    console.log("SUCCESS", runId, result.details.pdfStatus);
  } catch (error) {
    console.log("FAILED", runId, error.message, error.code, error.details);
  }
  console.log("events:", events.map(e => `${e.type}:${e.payload?.nodeId ?? e.payload?.status ?? ""}`).join(", "));
}

await runReport("conv1", "run1");
await runReport("conv2", "run2");
