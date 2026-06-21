import { createLlmClient, createLlmClientFromEnv } from "../dist/index.js";

const useRealProvider = process.argv.includes("--real");
const clientResult = useRealProvider ? createLlmClientFromEnv() : createMockClient();

if (!clientResult.ok) {
  console.error(JSON.stringify({ ok: false, step: "create_client", error: clientResult.error }, null, 2));
  process.exitCode = 1;
} else {
  const client = clientResult.data;
  const chat = await client.chat({
    messages: [{ role: "user", content: "解释一下 ROE 是什么？" }]
  });

  const json = await client.jsonChat({
    schemaName: "metric query",
    messages: [{ role: "user", content: "返回一个包含 ticker、metric、period 的 JSON。" }]
  });

  const tool = await client.toolChat({
    messages: [{ role: "user", content: "查询 000001.SZ 最近一期净利润。" }],
    tools: [
      {
        name: "financial_metric_lookup",
        description: "查询公司财务指标。",
        parameters: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            metric: { type: "string" },
            period: { type: "string" }
          },
          required: ["ticker", "metric"]
        }
      }
    ],
    toolChoice: useRealProvider ? "auto" : { name: "financial_metric_lookup" }
  });

  const summary = { ok: chat.ok && json.ok && tool.ok, mode: useRealProvider ? "real" : "mock", chat, json, tool };
  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function createMockClient() {
  let requestCount = 0;

  return {
    ok: true,
    data: createLlmClient({
      apiKey: "mock-key",
      baseUrl: "https://llm.mock/v1",
      model: "mock-model",
      fetch: async () => {
        requestCount += 1;

        if (requestCount === 1) {
          return jsonResponse({
            model: "mock-model",
            choices: [{ message: { content: "ROE 是净资产收益率，用来衡量公司用股东权益创造利润的能力。" } }]
          });
        }

        if (requestCount === 2) {
          return jsonResponse({
            model: "mock-model",
            choices: [{ message: { content: JSON.stringify({ ticker: "000001.SZ", metric: "roe", period: "latest" }) } }]
          });
        }

        return jsonResponse({
          model: "mock-model",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_mock_financial_metric",
                    type: "function",
                    function: {
                      name: "financial_metric_lookup",
                      arguments: JSON.stringify({
                        ticker: "000001.SZ",
                        metric: "net_income",
                        period: "latest"
                      })
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        });
      }
    })
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
