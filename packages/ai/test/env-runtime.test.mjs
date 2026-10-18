/**
 * env-runtime 模型元数据与模型选择单测。
 *
 * 每个用例都在受控 env 快照中运行：先清空全部 AIAGENT_LLM_* 变量，再按需注入，
 * 结束后整体恢复，避免宿主机 .env / 既有 shell 变量让用例互相污染。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAiCompatibleRuntime,
  resolveActiveModelFromEnv,
} from "../dist/index.js";

/** 所有 profile 的元数据变量后缀。 */
const PROFILES = ["DEEPSEEK", "OPENROUTER", "BRIDGE_AI"];

/** 需要在每个用例前清空的变量名。 */
const LLM_VARS = PROFILES.flatMap((profile) => [
  `AIAGENT_LLM_API_KEY_${profile}`,
  `AIAGENT_LLM_BASE_URL_${profile}`,
  `AIAGENT_LLM_MODEL_${profile}`,
  `AIAGENT_LLM_CONTEXT_WINDOW_${profile}`,
  `AIAGENT_LLM_MAX_TOKENS_${profile}`,
  `AIAGENT_LLM_REASONING_${profile}`,
  `AIAGENT_LLM_COST_IN_${profile}`,
  `AIAGENT_LLM_COST_OUT_${profile}`,
]);

/**
 * 在干净 env 中执行用例并恢复现场。
 *
 * @param env 本用例注入的变量。
 * @param run 用例主体。
 * @returns 用例返回值。
 */
function withEnv(env, run) {
  const saved = { ...process.env };
  try {
    for (const name of LLM_VARS) delete process.env[name];
    Object.assign(process.env, env);
    return run();
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
  }
}

/** deepseek 的最小可用配置。 */
const DEEPSEEK_BASE = {
  AIAGENT_LLM_API_KEY_DEEPSEEK: "test-key",
  AIAGENT_LLM_MODEL_DEEPSEEK: "deepseek-chat",
};

test("模型元数据：env 覆盖 contextWindow / maxTokens / reasoning / cost", () => {
  withEnv(
    {
      ...DEEPSEEK_BASE,
      AIAGENT_LLM_CONTEXT_WINDOW_DEEPSEEK: "64000",
      AIAGENT_LLM_MAX_TOKENS_DEEPSEEK: "4096",
      AIAGENT_LLM_REASONING_DEEPSEEK: "1",
      AIAGENT_LLM_COST_IN_DEEPSEEK: "0.27",
      AIAGENT_LLM_COST_OUT_DEEPSEEK: "1.1",
    },
    () => {
      const { runtime, error } = createOpenAiCompatibleRuntime("deepseek", "https://api.deepseek.com/v1");
      assert.equal(error, undefined);
      assert.equal(runtime.model.contextWindow, 64000);
      assert.equal(runtime.model.maxTokens, 4096);
      assert.equal(runtime.model.reasoning, true);
      assert.equal(runtime.model.cost.input, 0.27);
      assert.equal(runtime.model.cost.output, 1.1);
    },
  );
});

test("模型元数据：未配置时沿用默认值（128000 / 8192 / false / 0）", () => {
  withEnv(DEEPSEEK_BASE, () => {
    const { runtime } = createOpenAiCompatibleRuntime("deepseek", "https://api.deepseek.com/v1");
    assert.equal(runtime.model.contextWindow, 128000);
    assert.equal(runtime.model.maxTokens, 8192);
    assert.equal(runtime.model.reasoning, false);
    assert.deepEqual(runtime.model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

test("模型元数据：非法值回退默认值且不抛错", () => {
  withEnv(
    {
      ...DEEPSEEK_BASE,
      AIAGENT_LLM_CONTEXT_WINDOW_DEEPSEEK: "abc",
      AIAGENT_LLM_MAX_TOKENS_DEEPSEEK: "0",
      AIAGENT_LLM_REASONING_DEEPSEEK: "yes",
      AIAGENT_LLM_COST_IN_DEEPSEEK: "-1",
      AIAGENT_LLM_COST_OUT_DEEPSEEK: "NaN",
    },
    () => {
      const { runtime } = createOpenAiCompatibleRuntime("deepseek", "https://api.deepseek.com/v1");
      assert.equal(runtime.model.contextWindow, 128000);
      assert.equal(runtime.model.maxTokens, 8192);
      assert.equal(runtime.model.reasoning, false);
      assert.equal(runtime.model.cost.input, 0);
      assert.equal(runtime.model.cost.output, 0);
    },
  );
});

test("模型元数据：整数校验（1.5 与负数回退，true/false 双写都识别）", () => {
  withEnv(
    {
      ...DEEPSEEK_BASE,
      AIAGENT_LLM_CONTEXT_WINDOW_DEEPSEEK: "1.5",
      AIAGENT_LLM_MAX_TOKENS_DEEPSEEK: "-8",
      AIAGENT_LLM_REASONING_DEEPSEEK: "TRUE",
    },
    () => {
      const { runtime } = createOpenAiCompatibleRuntime("deepseek", "https://api.deepseek.com/v1");
      assert.equal(runtime.model.contextWindow, 128000);
      assert.equal(runtime.model.maxTokens, 8192);
      assert.equal(runtime.model.reasoning, true);
    },
  );
});

test("模型选择：只配置一个 profile 时选中它", () => {
  withEnv(
    {
      AIAGENT_LLM_API_KEY_OPENROUTER: "or-key",
      AIAGENT_LLM_MODEL_OPENROUTER: "openrouter/model",
    },
    () => {
      const active = resolveActiveModelFromEnv();
      assert.ok(active);
      assert.equal(active.model.provider, "openrouter");
      assert.equal(active.apiKey, "or-key");
    },
  );
});

test("模型选择：modelFlag 锁定已有 profile；不存在或未配置时返回 null", () => {
  withEnv(
    {
      AIAGENT_LLM_API_KEY_DEEPSEEK: "ds-key",
      AIAGENT_LLM_MODEL_DEEPSEEK: "deepseek-chat",
    },
    () => {
      assert.equal(resolveActiveModelFromEnv("deepseek").model.provider, "deepseek");
      assert.equal(resolveActiveModelFromEnv("openrouter"), null);
      assert.equal(resolveActiveModelFromEnv("not-a-profile"), null);
    },
  );
});

test("模型选择：全部未配置时返回 null；占位 key 视为未配置", () => {
  withEnv(
    {
      AIAGENT_LLM_API_KEY_DEEPSEEK: "replace-with-your-key",
      AIAGENT_LLM_MODEL_DEEPSEEK: "deepseek-chat",
    },
    () => {
      assert.equal(resolveActiveModelFromEnv(), null);
    },
  );
});
