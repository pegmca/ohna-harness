import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildModelCatalogFromSettings,
  readSettings,
  resolveModelFromSettings,
  resolveSettingsPath,
  writeSettings
} from "../dist/index.js";

test("settings 原子写入 0600，并保留真实模型列表", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ohna-settings-"));
  try {
    const settings = {
      defaultProfile: "bridge_ai",
      httpProxy: "http://127.0.0.1:1082",
      providers: {
        bridge_ai: {
          baseUrl: "http://192.168.5.8:8787/v1",
          model: "hy3-x",
          models: ["hy3", "hy3-x"],
          apiKey: "secret"
        }
      }
    };
    const path = await writeSettings(dataDir, settings);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(raw.providers.bridge_ai.models, ["hy3", "hy3-x"]);

    const loaded = await readSettings(dataDir);
    assert.equal(loaded.settings.defaultProfile, "bridge_ai");
    const model = resolveModelFromSettings(loaded.settings);
    assert.equal(model?.model.id, "hy3-x");
    assert.equal(model?.apiKey, "secret");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("OHNA_SETTINGS_PATH 可指向测试专用文件", () => {
  assert.equal(
    resolveSettingsPath("/tmp/data", { OHNA_SETTINGS_PATH: "/tmp/custom.json" }),
    "/tmp/custom.json"
  );
});

test("buildModelCatalogFromSettings：按 groups 生成多模型目录", () => {
  const catalog = buildModelCatalogFromSettings({
    defaultProfile: "bridge_ai",
    providers: {
      bridge_ai: {
        baseUrl: "http://host/v1",
        model: "hy3-x",
        apiKey: "k",
        models: ["hy3", "hy3-x"],
        groups: [
          { name: "主力", models: ["hy3-x", "hy3"] },
          { name: "推理", models: ["glm-5.3"] }
        ]
      }
    }
  });
  assert.ok(catalog);
  assert.equal(catalog.defaultModelId, "hy3-x");
  assert.deepEqual(
    catalog.models.map((model) => [model.id, model.group, model.isDefault]),
    [
      ["hy3-x", "主力", true],
      ["hy3", "主力", false],
      ["glm-5.3", "推理", false]
    ]
  );
});

test("resolveModelFromSettings 支持按 modelId 覆盖默认模型", () => {
  const settings = {
    defaultProfile: "bridge_ai",
    providers: {
      bridge_ai: { baseUrl: "http://host/v1", model: "hy3-x", apiKey: "k" }
    }
  };
  assert.equal(resolveModelFromSettings(settings)?.model.id, "hy3-x");
  assert.equal(resolveModelFromSettings(settings, "glm-5.3")?.model.id, "glm-5.3");
});
