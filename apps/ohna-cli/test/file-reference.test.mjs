/**
 * F-6 `@` 文件引用：片段识别、目录列举、过滤、展开（含越界 / 敏感 / 超限）与面板补全。
 *
 * 说明：文件系统用例全部在临时目录内构造，避免依赖仓库真实文件；越界用例在临时目录的
 * 父目录放文件，确保命中的是 `assertPathWithinRoot` 而不是「文件不存在」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  expandFileReferences,
  expandFileReferencesDetailed,
  filterWorkspaceFiles,
  findFileReferenceFragment,
  listWorkspaceFiles,
  MAX_FILE_REFERENCES,
} from "../dist/file-reference.js";
import { FileReferencePalette } from "../dist/tui-file-palette.js";

/**
 * 创建临时工作区并在结束后清理。
 *
 * @param fn 接收目录的测试体。
 */
async function withWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-fileref-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("findFileReferenceFragment：只识别行首 / 空白后的末尾 @ 片段，并剥离尾随标点", () => {
  assert.deepEqual(findFileReferenceFragment("看看 @src/a"), { fragment: "src/a", start: 3, end: 9 });
  assert.deepEqual(findFileReferenceFragment("@"), { fragment: "", start: 0, end: 1 });
  assert.deepEqual(findFileReferenceFragment("a @b @c"), { fragment: "c", start: 5, end: 7 });
  assert.deepEqual(findFileReferenceFragment("@src/a.ts，"), { fragment: "src/a.ts", start: 0, end: 9 });
  assert.deepEqual(findFileReferenceFragment("@src/a.ts。"), { fragment: "src/a.ts", start: 0, end: 9 });
  assert.deepEqual(findFileReferenceFragment("见 @src/a.ts)"), { fragment: "src/a.ts", start: 2, end: 11 });
  assert.equal(findFileReferenceFragment("mail@x.com"), null, "邮箱不应误判");
  assert.equal(findFileReferenceFragment("foo @a b"), null, "片段必须在末尾");
  assert.equal(findFileReferenceFragment("plain text"), null);
});

test("listWorkspaceFiles：跳过依赖 / 版本库 / 构建目录与敏感文件，返回 / 相对路径", async () => {
  await withWorkspace(async (dir) => {
    await mkdir(path.join(dir, "src", "nested"), { recursive: true });
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "a");
    await writeFile(path.join(dir, "src", "nested", "b.ts"), "b");
    await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "x");
    await writeFile(path.join(dir, ".git", "config"), "x");
    await writeFile(path.join(dir, "dist", "bundle.js"), "x");
    await writeFile(path.join(dir, ".env"), "SECRET=1");

    const files = await listWorkspaceFiles(dir);
    assert.ok(files.includes("src/a.ts"));
    assert.ok(files.includes("src/nested/b.ts"));
    assert.ok(!files.some((file) => file.startsWith("node_modules/")));
    assert.ok(!files.some((file) => file.startsWith(".git/")));
    assert.ok(!files.some((file) => file.startsWith("dist/")));
    assert.ok(!files.includes(".env"), "敏感文件应被 path-policy 过滤");
  });
});

test("filterWorkspaceFiles：文件名前缀优先，其次路径前缀 / 包含", () => {
  const files = ["src/model.ts", "src/app/helper.ts", "docs/about-model.md"];
  assert.deepEqual(filterWorkspaceFiles(files, "mod"), ["src/model.ts", "docs/about-model.md"]);
  assert.deepEqual(filterWorkspaceFiles(files, "app"), ["src/app/helper.ts"]);
  assert.deepEqual(filterWorkspaceFiles(files, ""), files);
});

test("expandFileReferences：无引用时原样返回字符串", async () => {
  await withWorkspace(async (dir) => {
    const content = await expandFileReferences("没有引用", dir);
    assert.equal(content, "没有引用");
  });
});

test("expandFileReferences：中文 / 英文尾随标点不参与路径解析", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
    for (const text of ["看 @a.ts，", "看 @a.ts。", "看 @a.ts)"]) {
      const result = await expandFileReferencesDetailed(text, dir);
      assert.ok(Array.isArray(result.content), `${text} 应识别为引用`);
      assert.equal(result.warnings.length, 0, `${text} 不应报文件不存在`);
      assert.match(result.content[1].text, /export const a = 1/);
      assert.equal(result.content[0].text, text, "原文本必须保留标点");
    }
  });
});

test("expandFileReferences：文件内容作为独立块追加，原文本保留", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
    const result = await expandFileReferencesDetailed("看看 @a.ts", dir);
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content.length, 2);
    assert.deepEqual(result.content[0], { type: "text", text: "看看 @a.ts" });
    assert.match(result.content[1].text, /文件 a\.ts：/);
    assert.match(result.content[1].text, /export const a = 1/);
    assert.deepEqual(result.warnings, []);
  });
});

test("expandFileReferences：不存在 / 越界 / 敏感 / 超限都只警告，不抛异常", async () => {
  await withWorkspace(async (dir) => {
    const parent = path.dirname(dir);
    const outside = path.join(parent, `outside-${Date.now()}.txt`);
    await writeFile(outside, "outside");
    await writeFile(path.join(dir, ".env"), "SECRET=1");
    await writeFile(path.join(dir, "big.txt"), "x".repeat(101 * 1024));

    try {
      const missing = await expandFileReferencesDetailed("@nope.ts", dir);
      assert.equal(missing.warnings.length, 1);
      assert.match(missing.warnings[0], /文件不存在/);
      assert.ok(Array.isArray(missing.content), "有引用时即使失败也返回数组");
      assert.deepEqual(missing.content[0], { type: "text", text: "@nope.ts" });

      const traversal = await expandFileReferencesDetailed(`@${outside}`, dir);
      assert.match(traversal.warnings[0], /越界/);

      const sensitive = await expandFileReferencesDetailed("@.env", dir);
      assert.match(sensitive.warnings[0], /敏感路径/);

      const oversized = await expandFileReferencesDetailed("@big.txt", dir);
      assert.match(oversized.warnings[0], /100KB/);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("expandFileReferences：同一文件去重，超过上限只展开前 5 个", async () => {
  await withWorkspace(async (dir) => {
    for (let i = 0; i < MAX_FILE_REFERENCES + 1; i += 1) {
      await writeFile(path.join(dir, `f${i}.txt`), `content-${i}`);
    }
    const duplicate = await expandFileReferencesDetailed("@f0.txt @f0.txt", dir);
    assert.equal(duplicate.content.length, 2, "原文本 + 一个文件块");

    const tooMany = await expandFileReferencesDetailed(
      Array.from({ length: MAX_FILE_REFERENCES + 1 }, (_, i) => `@f${i}.txt`).join(" "),
      dir,
    );
    assert.equal(tooMany.content.length, 1 + MAX_FILE_REFERENCES + 1, "原文本 + 5 个文件块 + 1 条上限说明");
    assert.equal(tooMany.warnings.length, 1);
    assert.match(tooMany.warnings[0], /最多引用 5 个文件/);
  });
});

test("FileReferencePalette：懒加载后可用 Tab 补全，Esc 关闭面板", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(path.join(dir, "alpha.ts"), "a");
    await writeFile(path.join(dir, "beta.ts"), "b");

    let loaded;
    const ready = new Promise((resolve) => {
      loaded = resolve;
    });
    const palette = new FileReferencePalette({ cwd: dir, onUpdate: loaded });

    assert.deepEqual(palette.buildLines("@"), [], "首次渲染时尚未加载");
    await ready;

    const lines = palette.buildLines("@");
    assert.equal(lines.length, 2);
    assert.match(lines.join("\n"), /@alpha\.ts/);

    const completion = palette.handleKey("\t", "@al");
    assert.equal(completion.consumed, true);
    assert.equal(completion.value, "@alpha.ts ");

    const punctuation = palette.handleKey("\t", "@al，");
    assert.equal(punctuation.value, "@alpha.ts，", "补全应保留尾随标点");

    const close = palette.handleKey("\x1b", "@al");
    assert.equal(close.consumed, true);
    assert.deepEqual(palette.buildLines("@al"), [], "Esc 后同一输入不再弹面板");
    // 输入变化后重新打开：继续输入到 @alph 再按 Tab 应正常补全。
    assert.equal(palette.handleKey("\t", "@alph").consumed, true);
  });
});
