/**
 * F-7 `#` 快速记忆：AGENTS.md 段落的创建、追加与「不覆盖其它内容」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendMemoryNote, MEMORY_SECTION_TITLE } from "../dist/workspace/memory-note.js";

/**
 * 创建临时工作区并在结束后清理。
 *
 * @param fn 接收目录的测试体。
 */
async function withWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-memory-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("appendMemoryNote：文件不存在时创建 AGENTS.md 与用户记忆段", async () => {
  await withWorkspace(async (dir) => {
    const result = await appendMemoryNote("  测试命令用 pnpm  ", dir);
    assert.equal(result.ok, true);
    assert.equal(result.path, path.join(dir, "AGENTS.md"));
    const content = await readFile(result.path, "utf8");
    assert.ok(content.includes(MEMORY_SECTION_TITLE));
    assert.match(content, /- 测试命令用 pnpm/);
  });
});

test("appendMemoryNote：已有段落在中间时插到该段末尾，不动后续段落", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "AGENTS.md");
    await writeFile(
      file,
      `# 项目\n\n${MEMORY_SECTION_TITLE}\n\n- 旧记忆\n\n## 其它规范\n\n保持不变\n`,
    );
    const result = await appendMemoryNote("新记忆", dir);
    assert.equal(result.ok, true);
    const content = await readFile(file, "utf8");
    const memoryIndex = content.indexOf("- 旧记忆");
    const newIndex = content.indexOf("- 新记忆");
    const otherIndex = content.indexOf("## 其它规范");
    assert.ok(memoryIndex < newIndex && newIndex < otherIndex, "新条目应在段落内、其它标题前");
    assert.match(content, /## 其它规范\n\n保持不变/);
  });
});

test("appendMemoryNote：空内容拒绝且不创建文件", async () => {
  await withWorkspace(async (dir) => {
    const result = await appendMemoryNote("   ", dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /为空/);
    await assert.rejects(readFile(path.join(dir, "AGENTS.md"), "utf8"));
  });
});

test("appendMemoryNote：跳过围栏代码块里的伪标题，并保留 CRLF", async () => {
  await withWorkspace(async (dir) => {
    const file = path.join(dir, "AGENTS.md");
    const existing = [
      "# 项目",
      "",
      "```md",
      MEMORY_SECTION_TITLE,
      "- 这只是示例",
      "```",
      "",
      "## 真实段落",
      "内容",
      "",
    ].join("\r\n");
    await writeFile(file, existing);

    const result = await appendMemoryNote("CRLF 记忆", dir);
    assert.equal(result.ok, true);
    const content = await readFile(file, "utf8");
    // 代码块里的标题不算真实段落：应在文件末尾新建一个真实段落。
    assert.equal(content.split(MEMORY_SECTION_TITLE).length - 1, 2);
    assert.ok(content.endsWith(`${MEMORY_SECTION_TITLE}\r\n\r\n- CRLF 记忆\r\n`));
    assert.ok(!content.replace(/\r\n/g, "").includes("\n"), "写回必须保持 CRLF，不出现裸 LF");
  });
});
