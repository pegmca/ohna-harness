/**
 * 编码工具 effect 标注测试（K1 单一事实源）。
 *
 * 7 个内置工具必须自带副作用声明：权限闸门据此决定直接放行还是进入策略，
 * 不再依赖任何宿主名单常量。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCodingToolRegistry, createReadOnlyToolRegistry } from "../dist/index.js";

test("7 个编码工具的 effect 标注正确", () => {
  const registry = createCodingToolRegistry("/tmp/ohna-effects");
  const effects = Object.fromEntries(registry.map((tool) => [tool.name, tool.effect]));

  assert.deepEqual(effects, {
    read: "read",
    write: "mutate",
    edit: "mutate",
    bash: "mutate",
    grep: "read",
    find: "read",
    ls: "read"
  });
});

test("createReadOnlyToolRegistry 只产出只读工具，且 effect 全为 read", () => {
  const registry = createReadOnlyToolRegistry("/tmp/ohna-effects");
  assert.deepEqual(
    registry.map((tool) => tool.name).sort(),
    ["find", "grep", "ls", "read"]
  );
  assert.deepEqual(
    registry.filter((tool) => tool.effect !== "read").map((tool) => tool.name),
    []
  );
});
