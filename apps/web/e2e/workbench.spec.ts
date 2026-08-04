import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 阶段 4 新协议 e2e：全部后端接口用 page.route mock，SSE 以完整帧文本模拟。
 * 覆盖：流式渲染、tool call 折叠/展开、刷新后历史、多轮含附件提问、可访问性与移动端 drawer。
 */

const CONVERSATION = {
  conversationId: "c1",
  title: "已有会话",
  status: "active",
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
  lastMessageAt: "2026-07-25T00:00:00.000Z"
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/models", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        requestId: "models_test",
        data: {
          defaultModelId: "mock",
          models: [{
            id: "mock",
            label: "Mock Agent",
            provider: "mock",
            description: "Test model",
            isDefault: true,
            capabilities: { structuredOutput: true, toolCalling: true }
          }]
        }
      })
    });
  });
  await page.route("**/api/identity/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        requestId: "identity_test",
        data: {
          userId: "user_browser_test",
          createdAt: "2026-07-24T00:00:00.000Z",
          qqBot: { enabled: false, status: "disabled" }
        }
      })
    });
  });
});

test("chat shell is accessible and responsive", async ({ page }, testInfo) => {
  await mockConversations(page, []);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Agent Chat 主区域" })).toBeVisible();
  await expect(page.getByRole("textbox")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);

  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "打开会话列表" }).click();
    await expect(page.getByRole("complementary", { name: "会话列表" })).toHaveClass(/is-open/);
  }
});

test("streams the assistant reply progressively and resumes after a broken stream", async ({ page }) => {
  await mockConversations(page, [CONVERSATION]);
  await page.route("**/api/conversations/c1/messages?*", async (route) => {
    await fulfillJson(route, { items: [] });
  });

  // 第一段 SSE 只给中间态就断流；客户端应带 afterSequence 续传第二段拿终态。
  let sseRequests = 0;
  const resumeUrls: string[] = [];
  await page.route("**/api/runs/run-1/events*", async (route) => {
    sseRequests += 1;
    resumeUrls.push(route.request().url());
    if (sseRequests === 1) {
      await fulfillSse(route, [
        frame(1, "message_update", partial("text_start", [{ type: "text", text: "净利润" }])),
        frame(2, "message_update", partial("text_delta", [{ type: "text", text: "净利润同比" }]))
      ]);
      return;
    }
    await fulfillSse(route, [
      frame(3, "message_update", partial("text_delta", [{ type: "text", text: "净利润同比增长 12%。" }])),
      frame(4, "agent_end", {
        messages: [{ role: "assistant", content: [{ type: "text", text: "净利润同比增长 12%。" }] }]
      })
    ]);
  });
  await page.route("**/api/runs", async (route) => {
    await fulfillJson(route, accepted("run-1"));
  });

  await page.goto("/?conversation=c1");
  await page.getByRole("textbox").fill("净利润变化如何？");
  await page.getByRole("button", { name: "发送" }).click();

  // 第一段流的中间态直接由累积 partial 渲染。
  await expect(page.getByText("净利润同比")).toBeVisible();
  // 断流续传后渲染最终回答。
  await expect(page.getByText("净利润同比增长 12%。")).toBeVisible();
  expect(sseRequests).toBeGreaterThanOrEqual(2);
  expect(resumeUrls[1]).toContain("afterSequence=2");
});

test("collapses tool calls by default and expands to show arguments and result", async ({ page }) => {
  await mockConversations(page, [CONVERSATION]);
  await page.route("**/api/conversations/c1/messages?*", async (route) => {
    await fulfillJson(route, { items: [] });
  });
  await page.route("**/api/runs", async (route) => {
    await fulfillJson(route, accepted("run-1"));
  });
  await page.route("**/api/runs/run-1/events*", async (route) => {
    // 真实两消息结构：第一条 assistant 发起 toolCall（配对 toolResult），第二条流式输出总结。
    const toolCallContent = [
      { type: "toolCall", id: "call-1", name: "query_metrics", arguments: { ticker: "000001.SZ" } }
    ];
    await fulfillSse(route, [
      frame(1, "message_start", { message: { role: "assistant", content: [] } }),
      frame(2, "message_update", partial("toolcall_end", toolCallContent)),
      frame(3, "tool_execution_start", { toolCallId: "call-1", toolName: "query_metrics", args: { ticker: "000001.SZ" } }),
      frame(4, "tool_execution_end", {
        toolCallId: "call-1",
        toolName: "query_metrics",
        result: [{ type: "text", text: "ROE 12%" }],
        isError: false
      }),
      frame(5, "message_end", { message: { role: "assistant", content: toolCallContent } }),
      frame(6, "message_start", { message: { role: "assistant", content: [] } }),
      frame(7, "message_update", partial("text_delta", [{ type: "text", text: "ROE 为 12%。" }])),
      frame(8, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "ROE 为 12%。" }] } }),
      frame(9, "agent_end", {
        messages: [
          { role: "assistant", content: toolCallContent },
          {
            role: "toolResult",
            content: { toolCallId: "call-1", toolName: "query_metrics", content: [{ type: "text", text: "ROE 12%" }], isError: false }
          },
          { role: "assistant", content: [{ type: "text", text: "ROE 为 12%。" }] }
        ]
      })
    ]);
  });

  await page.goto("/?conversation=c1");
  await page.getByRole("textbox").fill("查询 ROE");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("ROE 为 12%。")).toBeVisible();
  // 默认折叠：参数与结果不可见。
  const toolSummary = page.locator(".tool-call-block summary", { hasText: "query_metrics" });
  await expect(toolSummary).toBeVisible();
  await expect(page.getByText("ROE 12%")).toBeHidden();
  // 展开后可见配对结果；参数在二级 JSON 折叠里，再展开一次。
  await toolSummary.click();
  await expect(page.getByText("ROE 12%")).toBeVisible();
  await page.locator(".json-details summary", { hasText: "调用参数" }).click();
  await expect(page.getByText(/"ticker": "000001.SZ"/)).toBeVisible();
});

test("restores full history after a reload", async ({ page }) => {
  await mockConversations(page, [CONVERSATION]);
  await page.route("**/api/conversations/c1/messages?*", async (route) => {
    await fulfillJson(route, {
      items: [
        linearMessage("u1", "user", "查一下 ROE", 1),
        linearMessage("a1", "assistant", [
          { type: "thinking", thinking: "需要先取净利润" },
          { type: "text", text: "ROE 为 12%。" }
        ], 2, { runId: "run-1", modelId: "mock", stopReason: "stop" }),
        linearMessage("x1", "user", "[compaction] 更早历史已压缩", 3, { messageType: "compaction" })
      ]
    });
  });

  await page.goto("/?conversation=c1");
  await expect(page.getByText("查一下 ROE")).toBeVisible();
  await expect(page.getByText("ROE 为 12%。")).toBeVisible();
  await expect(page.getByText("历史已压缩")).toBeVisible();
  // thinking 默认折叠。
  await expect(page.locator(".thinking-block").getByText("需要先取净利润")).toBeHidden();

  await page.reload();
  await expect(page.getByText("查一下 ROE")).toBeVisible();
  await expect(page.getByText("ROE 为 12%。")).toBeVisible();
  await expect(page.getByText("历史已压缩")).toBeVisible();
});

test("sends multiple turns with attachments and passes attachmentDocumentIds", async ({ page }) => {
  await mockConversations(page, [CONVERSATION]);
  await page.route("**/api/conversations/c1/messages?*", async (route) => {
    await fulfillJson(route, { items: [] });
  });
  await page.route("**/api/attachments", async (route) => {
    const request = route.request().postDataJSON() as { clientAttachmentId: string; fileName: string };
    await fulfillJson(route, {
      attachmentId: request.clientAttachmentId,
      documentId: "doc-annual-report",
      fileName: request.fileName,
      contentType: "text/markdown",
      sizeBytes: 12,
      status: "indexed"
    });
  });
  const runBodies: Array<{ message: string; attachmentDocumentIds?: string[] }> = [];
  await page.route("**/api/runs", async (route) => {
    runBodies.push(route.request().postDataJSON() as { message: string; attachmentDocumentIds?: string[] });
    await fulfillJson(route, accepted(`run-${runBodies.length}`));
  });
  await page.route("**/api/runs/*/events*", async (route) => {
    await fulfillSse(route, [
      frame(1, "message_update", partial("text_delta", [{ type: "text", text: "回答完成。" }])),
      frame(2, "agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "回答完成。" }] }] })
    ]);
  });

  await page.goto("/?conversation=c1");
  // 第一轮：带附件提问。
  await page.locator('input[type="file"]').setInputFiles({
    name: "annual-report.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 年报摘要")
  });
  await expect(page.getByText("annual-report.md")).toBeVisible();
  await page.getByRole("textbox").fill("结合附件总结年报");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("回答完成。")).toBeVisible();

  // 第二轮：纯文本追问。
  await page.getByRole("textbox").fill("再补充现金流");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("回答完成。").nth(1)).toBeVisible();

  expect(runBodies).toHaveLength(2);
  expect(runBodies[0].attachmentDocumentIds).toEqual(["doc-annual-report"]);
  expect(runBodies[1].attachmentDocumentIds ?? []).toEqual([]);
});

/** @param page 页面。 @param items 会话列表。 @returns 无返回值。 */
async function mockConversations(page: Page, items: unknown[]): Promise<void> {
  await page.route("**/api/conversations?*", async (route) => {
    await fulfillJson(route, { items });
  });
}

/** @param runId Run ID。 @returns accepted DTO。 */
function accepted(runId: string) {
  return {
    runId,
    requestId: `request_${runId}`,
    conversationId: "c1",
    modelId: "mock",
    status: "queued",
    eventsUrl: `/api/runs/${runId}/events`,
    snapshotUrl: `/api/runs/${runId}`
  };
}

/** @param route 命中的路由。 @param data data 字段。 @returns 无返回值。 */
async function fulfillJson(route: Route, data: unknown): Promise<void> {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, requestId: "e2e", data })
  });
}

/** @param route 命中的路由。 @param frames SSE 帧列表。 @returns 无返回值。 */
async function fulfillSse(route: Route, frames: string[]): Promise<void> {
  await route.fulfill({
    contentType: "text/event-stream",
    body: `${frames.join("\n\n")}\n\n`
  });
}

/** @param sequence 序号。 @param type 事件类型。 @param payload 事件本体。 @returns 完整 SSE 帧文本。 */
function frame(sequence: number, type: string, payload: unknown): string {
  const envelope = {
    eventId: `event-${sequence}`,
    runId: "run-1",
    requestId: "request-1",
    conversationId: "c1",
    sequence,
    type,
    payload,
    createdAt: "2026-07-25T00:00:00.000Z"
  };
  return `id: ${sequence}\nevent: run_event\ndata: ${JSON.stringify(envelope)}`;
}

/** @param kind AssistantMessageEvent 类型。 @param content 累积 partial 内容。 @returns message_update payload。 */
function partial(kind: string, content: unknown) {
  return {
    message: { role: "assistant", content },
    assistantMessageEvent: { type: kind, contentIndex: 0, partial: { role: "assistant", content } }
  };
}

/** @param messageId 消息 ID。 @param role 角色。 @param content content 本体。 @param sequence 序号。 @param extra 附加字段。 @returns LinearMessageDto。 */
function linearMessage(
  messageId: string,
  role: string,
  content: unknown,
  sequence: number,
  extra: Record<string, unknown> = {}
) {
  return {
    messageId,
    conversationId: "c1",
    role,
    content,
    messageType: "normal",
    sequence,
    createdAt: "2026-07-25T00:00:00.000Z",
    ...extra
  };
}
