/**
 * ohna 评测 judge-rubrics 测试（judge-rubrics.ts 工作项）。
 *
 * 验证：
 * 1) 两个 rubric 的 systemPrompt 常量均为非空字符串（rubric 文本留 app）；
 * 2) 缺 callModel 注入时 createOhnaCodingJudge 返回 null（不静默回退，不影响确定性门禁）；
 * 3) 注入 callModel 时返回非 null 适配器，且能对各 rubric 打分（确定性可离线验证）；
 * 4) callModel 异常时降级为中性分（不向上抛）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOhnaCodingJudge,
  FILE_CHANGE_QUALITY_SYSTEM_PROMPT,
  TOOL_CHOICE_RATIONALE_SYSTEM_PROMPT,
} from "../dist/eval/judge-rubrics.js";
import { NEUTRAL_SCORE } from "@aiagent/eval-core";

test("两个 rubric systemPrompt 常量均为非空字符串", () => {
  assert.equal(typeof FILE_CHANGE_QUALITY_SYSTEM_PROMPT, "string");
  assert.equal(typeof TOOL_CHOICE_RATIONALE_SYSTEM_PROMPT, "string");
  assert.ok(FILE_CHANGE_QUALITY_SYSTEM_PROMPT.length > 0);
  assert.ok(TOOL_CHOICE_RATIONALE_SYSTEM_PROMPT.length > 0);
});

test("缺 callModel 注入时返回 null（不静默回退）", () => {
  const judge = createOhnaCodingJudge();
  assert.equal(judge, null, "无 provider 配置时应返回 null，由 run 层跳过 judge");
});

test("注入 callModel 时可对两个 rubric 打分且不抛异常", async () => {
  const callModel = async () => JSON.stringify({ score: 0.8, reason: "测试" });
  const judge = createOhnaCodingJudge({ callModel });
  assert.ok(judge, "应返回非 null 适配器");

  const case_ = { id: "t", prompt: "升级版本号", expectedFileChanges: [], workspaceSeed: [] };
  const evidence = {
    trajectory: [{ tool: "read", args: { path: "a.ts" } }, { tool: "edit", args: { path: "a.ts" } }],
    deniedTools: [],
    workspaceSnapshot: new Map([["a.ts", "v1"]]),
    actualTurns: 2,
  };

  const q = await judge.score("fileChangeQuality", case_, evidence);
  const r = await judge.score("toolChoiceRationale", case_, evidence);
  assert.equal(q, 0.8);
  assert.equal(r, 0.8);
});

test("callModel 异常时降级为中性分（不抛）", async () => {
  const callModel = async () => {
    throw new Error("network down");
  };
  const judge = createOhnaCodingJudge({ callModel });
  assert.ok(judge);

  const case_ = { id: "t", prompt: "p", expectedFileChanges: [], workspaceSeed: [] };
  const evidence = {
    trajectory: [],
    deniedTools: [],
    workspaceSnapshot: new Map(),
    actualTurns: 1,
  };
  // 注入 callModel 抛错时由 judge 内部 try/catch 降级为 NEUTRAL_SCORE，不向上抛。
  const score = await judge.score("fileChangeQuality", case_, evidence).catch(() => -1);
  assert.equal(score, NEUTRAL_SCORE);
});
