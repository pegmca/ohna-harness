/**
 * project-context.ts 单元测试：项目上下文装配与「尽力而为」降级。
 *
 * 全部用例都在 os.tmpdir() 下的自建临时目录中运行（tmpdir 先 realpath，规避 macOS 软链差异），
 * 验证缺失文件 / 非 git 目录不报错、package.json scripts 被列出、超长段落被截断。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectContext } from "../dist/context/project-context.js";

/** 本文件创建的所有临时目录，统一在 after 钩子里清理。 */
const tempDirs = [];

/**
 * 在 os.tmpdir() 下创建一个已 realpath 规范化的空临时目录。
 *
 * @returns 临时目录绝对路径。
 */
function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "coding-project-context-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空目录：缺文件与非 git 目录都不报错，走降级文案", async () => {
  const cwd = makeTempDir();
  const markdown = await loadProjectContext(cwd);

  assert.match(markdown, /^# 项目上下文\n/);
  assert.ok(markdown.includes("- 工作区根目录：" + cwd));
  // git 不可用时给出降级说明而不是抛错
  assert.ok(markdown.includes("- Git：不可用或非 git 仓库"));
  assert.equal(markdown.includes("- Git 分支："), false);
  // 没有 package.json 时不应出现脚本段落
  assert.equal(markdown.includes("## 可用脚本（package.json）"), false);
  assert.equal(markdown.includes("## 项目约定（AGENTS.md）"), false);
  assert.equal(markdown.includes("## 设计规范（DESIGN.md）"), false);
});

test("package.json 的 scripts 被逐条列出", async () => {
  const cwd = makeTempDir();
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "demo", scripts: { build: "tsc -b", test: "node --test" } }, null, 2),
  );

  const markdown = await loadProjectContext(cwd);
  assert.ok(markdown.includes("## 可用脚本（package.json）"));
  assert.ok(markdown.includes("- build：tsc -b"));
  assert.ok(markdown.includes("- test：node --test"));
});

test("package.json 缺失 / 无 scripts / JSON 非法时静默跳过脚本段", async () => {
  const noPkg = makeTempDir();
  assert.equal((await loadProjectContext(noPkg)).includes("## 可用脚本（package.json）"), false);

  const noScripts = makeTempDir();
  writeFileSync(join(noScripts, "package.json"), JSON.stringify({ name: "demo" }));
  assert.equal((await loadProjectContext(noScripts)).includes("## 可用脚本（package.json）"), false);

  const broken = makeTempDir();
  writeFileSync(join(broken, "package.json"), "{ not json");
  const brokenMarkdown = await loadProjectContext(broken);
  assert.equal(brokenMarkdown.includes("## 可用脚本（package.json）"), false);
  assert.match(brokenMarkdown, /^# 项目上下文\n/);
});

test("AGENTS.md 与 DESIGN.md 存在时被装配进上下文", async () => {
  const cwd = makeTempDir();
  writeFileSync(join(cwd, "AGENTS.md"), "# 约定\n- 使用 pnpm\n");
  writeFileSync(join(cwd, "DESIGN.md"), "# 规范\n- 使用 design token\n");

  const markdown = await loadProjectContext(cwd);
  assert.ok(markdown.includes("## 项目约定（AGENTS.md）"));
  assert.ok(markdown.includes("## 设计规范（DESIGN.md）"));
  assert.ok(markdown.includes("- 使用 pnpm"));
  assert.ok(markdown.includes("- 使用 design token"));
  // 段落顺序：约定在设计规范之前
  assert.ok(markdown.indexOf("项目约定") < markdown.indexOf("设计规范"));
});

test("超长约定文件按字节上限截断并标注", async () => {
  const cwd = makeTempDir();
  const longLine = "- " + "x".repeat(80) + "\n";
  const raw = longLine.repeat(300); // 约 24KB，远超 8KB 段落上限
  writeFileSync(join(cwd, "AGENTS.md"), raw);

  const markdown = await loadProjectContext(cwd);
  assert.ok(markdown.includes("（该文件过长，已按字节上限截断）"));
  // 截断后正文应显著短于原始内容
  const section = markdown.split("## 项目约定（AGENTS.md）")[1] ?? "";
  assert.ok(section.length < raw.length);
  assert.ok(section.length > 0);
});

test("git 仓库中列出分支信息", async () => {
  const cwd = makeTempDir();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd, stdio: "ignore" });

  const markdown = await loadProjectContext(cwd);
  assert.equal(markdown.includes("- Git：不可用或非 git 仓库"), false);
  assert.match(markdown, /- Git 分支：.*main/);
  assert.ok(markdown.includes("- 未提交改动："));
});

test("子目录不存在时上下文仍以工作区根为准", async () => {
  const cwd = makeTempDir();
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src/index.ts"), "export const a = 1;\n");
  // src/index.ts 不是上下文文件，不应被误装配
  const markdown = await loadProjectContext(cwd);
  assert.equal(markdown.includes("index.ts"), false);
  assert.ok(markdown.endsWith("\n"));
});
