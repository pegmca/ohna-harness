/**
 * 命令注册表单测（Phase C2）：别名解析、面板过滤、帮助生成、可见性，以及
 * 「新增命令只改一处」的可扩展性证明。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_DEFINITIONS,
  COMMAND_REGISTRY,
  CommandRegistry,
  createSlashDispatcher,
  filterSlashCommands,
  listPanelCommands,
  parseSlashCommand,
} from "../dist/commands/registry.js";

test("parseSlashCommand：命令名与参数切分保持旧行为", () => {
  assert.deepEqual(parseSlashCommand("/model deepseek"), { name: "model", arg: "deepseek" });
  assert.deepEqual(parseSlashCommand("/resume"), { name: "resume", arg: "" });
  assert.deepEqual(parseSlashCommand("  /COST  "), { name: "cost", arg: "" });
  assert.deepEqual(parseSlashCommand("/permissions mode plan"), { name: "permissions", arg: "mode plan" });
  assert.equal(parseSlashCommand("帮我看看这个文件"), null);
  assert.equal(parseSlashCommand("/nope"), null);
  assert.equal(parseSlashCommand(""), null);
});

test("别名表：13 条命令的全部历史别名原样保留", () => {
  const aliases = {
    "/help": "help",
    "/?": "help",
    help: "help",
    "/clear": "clear",
    "/reset": "clear",
    "/cost": "cost",
    "/model": "model",
    "/compact": "compact",
    "/tools": "tools",
    "/resume": "resume",
    "/exit": "exit",
    "/quit": "exit",
    "/q": "exit",
    ":q": "exit",
    exit: "exit",
    quit: "exit",
    "/verbose": "verbose",
    "/permissions": "permissions",
    "/status": "status",
    "/mcp": "mcp",
    "/export": "export",
  };
  for (const [alias, name] of Object.entries(aliases)) {
    assert.equal(parseSlashCommand(alias)?.name, name, `别名 ${alias} 应解析为 ${name}`);
  }
});

test("filterSlashCommands：按前缀过滤、大小写不敏感、空串返回全部可见命令", () => {
  assert.equal(filterSlashCommands("").length, 12);
  assert.equal(filterSlashCommands("/").length, 12);
  assert.deepEqual(filterSlashCommands("/he").map((c) => c.name), ["/help"]);
  assert.deepEqual(filterSlashCommands("/HE").map((c) => c.name), ["/help"]);
  assert.equal(filterSlashCommands("/help").length, 1);
  assert.equal(filterSlashCommands("foo").length, 0);
  // /verbose 是隐藏命令：不进面板，也不被面板过滤命中。
  assert.equal(filterSlashCommands("/verbose").length, 0);
});

test("面板可见性：12 条可见命令 + /verbose 隐藏，顺序保持不变", () => {
  const names = listPanelCommands().map((c) => c.name);
  assert.deepEqual(names, [
    "/help",
    "/clear",
    "/cost",
    "/model",
    "/compact",
    "/tools",
    "/resume",
    "/exit",
    "/permissions",
    "/status",
    "/mcp",
    "/export",
  ]);
  assert.equal(COMMAND_REGISTRY.get("verbose")?.panel, false, "/verbose 必须继续隐藏");
  assert.equal(COMMAND_DEFINITIONS.length, 13, "注册表应覆盖 13 条命令（含隐藏项）");
});

test("/help 文案：从注册表生成，名称与描述两列对齐", () => {
  const lines = COMMAND_REGISTRY.helpLines();
  assert.equal(lines.length, 12);
  assert.match(lines[0], /^ {2}\/help +查看会话内命令$/);
  assert.ok(lines.some((line) => line.includes("/permissions") && line.includes("权限模式")));
  // 每一行都必须能反查出真实命令，避免帮助与解析脱节。
  for (const line of lines) {
    const name = line.trim().split(/\s+/)[0];
    assert.ok(filterSlashCommands(name).some((entry) => entry.name === name), `${name} 应可被过滤命中`);
  }
});

test("createSlashDispatcher：从注册表解析并消费 context，普通输入返回 false", async () => {
  const calls = [];
  const dispatch = createSlashDispatcher({
    context: {
      tools: () => calls.push("tools"),
      model: (arg) => calls.push(`model:${arg}`),
      stats: () => calls.push("stats"),
    },
  });
  assert.equal(await dispatch("/tools"), true);
  assert.equal(await dispatch("/model deepseek"), true);
  assert.equal(await dispatch("普通问题"), false);
  assert.deepEqual(calls, ["tools", "model:deepseek"]);
});

test("createSlashDispatcher：已注册但当前模式未提供的 handler 走 onUnknown", async () => {
  const unknown = [];
  const dispatch = createSlashDispatcher({
    context: {},
    onUnknown: (name) => unknown.push(name),
  });
  assert.equal(await dispatch("/exit"), true);
  assert.deepEqual(unknown, ["exit"]);
});

test("新增命令只改一处：定义表加一条即可同时被解析 / 过滤 / 帮助 / 分发感知", async () => {
  // 模拟「只改注册表定义」：parser / filter / help / dispatcher 代码均未改动。
  const registry = new CommandRegistry([
    ...COMMAND_DEFINITIONS,
    {
      id: "session.stats",
      title: "统计",
      description: "查看会话统计",
      slash: { name: "/stats", aliases: ["/st"] },
      run: async (ctx, arg) => {
        await ctx.stats?.(arg);
      },
    },
  ]);

  assert.deepEqual(registry.parse("/st"), { name: "stats", arg: "" });
  assert.deepEqual(registry.parse("/stats 7"), { name: "stats", arg: "7" });
  assert.deepEqual(
    registry.filter("/stats").map((entry) => entry.name),
    ["/stats"],
  );
  assert.ok(registry.helpLines().some((line) => line.includes("/stats")));

  const calls = [];
  const dispatch = createSlashDispatcher({
    registry,
    context: { stats: (arg) => calls.push(arg) },
  });
  assert.equal(await dispatch("/st 42"), true);
  assert.deepEqual(calls, ["42"]);
});

test("/verbose 元数据：不再声明 ctrl+o 键位，描述与现行为一致（m4）", () => {
  const def = COMMAND_REGISTRY.get("verbose");
  assert.ok(def);
  assert.equal(def.keys, undefined, "ctrl+o 现为「折叠最近分组」，不再是 /verbose 的等价入口");
  assert.match(def.description, /折叠分组/, "描述应说明 Ctrl+O 的真实语义");
});
