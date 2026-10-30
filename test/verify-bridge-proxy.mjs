/**
 * 真实 provider 验证：不 mock，直接经 AIAGENT_HTTP_PROXY 调 Bridge AI。
 * 用法：AIAGENT_HTTP_PROXY=http://127.0.0.1:1082 node test/verify-bridge-proxy.mjs
 */
import { stream } from "../packages/ai/dist/index.js";

const model = {
  id: "hy3-x",
  name: "hy3-x",
  api: "openai-completions",
  provider: "bridge_ai",
  baseUrl: "http://192.168.5.8:8787/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096
};

const response = stream(
  model,
  {
    systemPrompt: "你是严格的测试助手，只回复 OK。",
    messages: [{ role: "user", content: "请只回复 OK", timestamp: Date.now() }],
    tools: []
  },
  {
    apiKey: process.env.BRIDGE_KEY,
    maxTokens: 32
  }
);

for await (const event of response) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
const final = await response.result();
console.log("\nstopReason=", final.stopReason, "error=", final.errorMessage ?? "none");
