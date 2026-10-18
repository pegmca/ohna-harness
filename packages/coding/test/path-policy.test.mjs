/**
 * path-policy.ts 单元测试：越界判定与敏感路径判定。
 *
 * 用例刻意使用 os.tmpdir() 下的真实临时目录（并 realpath 规范化），
 * 因为 macOS 的 tmpdir 是软链，不规范化会让「工作区内放行」与「相邻目录拒绝」两种断言失去意义。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPathWithinRoot, isDeniedPath } from "../dist/policy/path-policy.js";
import { createReadTool } from "../dist/tools/read.js";
import { createWriteTool } from "../dist/tools/write.js";

/** 本文件创建的所有临时目录，统一在 after 钩子里清理。 */
const tempDirs = [];

/**
 * 在 os.tmpdir() 下创建一个已 realpath 规范化的临时目录。
 *
 * @returns 临时目录绝对路径。
 */
function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "coding-path-policy-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 断言工具调用被策略层拒绝，并返回稳定的 permission_denied 结构。
 *
 * @param tool 工具实例。
 * @param params 工具入参。
 * @returns 无返回值；断言失败时由 assert 抛出。
 */
async function expectPermissionDenied(tool, params) {
  await assert.rejects(
    () => tool.execute("test-tool-call", params),
    (error) => {
      assert.equal(error.code, "permission_denied");
      return true;
    },
  );
}

test("工作区内的路径一律放行（含根目录自身与不存在的新文件）", () => {
  const root = makeTempDir();
  assert.deepEqual(assertPathWithinRoot(root, root), { ok: true });
  assert.deepEqual(assertPathWithinRoot(join(root, "src/index.ts"), root), { ok: true });
  assert.deepEqual(assertPathWithinRoot(join(root, "src"), root), { ok: true });
  // 写入类工具常见场景：目标文件尚不存在，向上找到最近已存在祖先即可判定
  assert.deepEqual(assertPathWithinRoot(join(root, "a/b/c/new.ts"), root), { ok: true });
});

test("相邻同前缀目录（coding-root-evil）必须拒绝", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "coding-root-"));
  tempDirs.push(root);
  const sibling = root + "-evil";
  mkdirSync(sibling);
  tempDirs.push(sibling);

  const verdict = assertPathWithinRoot(sibling, root);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /outside the allowed workspace root/);
  // 同前缀目录下的文件同样越界
  assert.equal(assertPathWithinRoot(join(sibling, "secret.txt"), root).ok, false);
});

test("工作区外的系统路径（/etc/passwd）必须拒绝", () => {
  const root = makeTempDir();
  const verdict = assertPathWithinRoot("/etc/passwd", root);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /outside the allowed workspace root/);
  assert.equal(assertPathWithinRoot("/tmp", root).ok, false);
  assert.equal(assertPathWithinRoot("/etc", root).ok, false);
});

test("穿越软链的越界路径必须拒绝", () => {
  const root = makeTempDir();
  const link = join(root, "escape-link");
  symlinkSync("/etc", link);
  // canonicalizePath 会跟随软链，暴露出真实目标在 root 之外
  const verdict = assertPathWithinRoot(link, root);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /outside the allowed workspace root/);
});

test("路径或工作区根缺失时返回结构化原因", () => {
  const root = makeTempDir();
  assert.deepEqual(assertPathWithinRoot("", root), { ok: false, reason: "Path is empty" });
  assert.deepEqual(assertPathWithinRoot(join(root, "a.ts"), ""), {
    ok: false,
    reason: "Workspace root is not configured",
  });
});

test("isDeniedPath 命中环境文件与私钥类文件", () => {
  const root = makeTempDir();
  assert.equal(isDeniedPath(join(root, ".env")), true);
  assert.equal(isDeniedPath(join(root, ".env.local")), true);
  assert.equal(isDeniedPath(join(root, ".env.production")), true);
  assert.equal(isDeniedPath(join(root, "config/server.pem")), true);
  assert.equal(isDeniedPath(join(root, "certs/tls.key")), true);
  assert.equal(isDeniedPath(join(root, "certs/ca.p12")), true);
});

test("isDeniedPath 命中敏感目录（.git / node_modules / .ssh）", () => {
  const root = makeTempDir();
  assert.equal(isDeniedPath(join(root, ".git/config")), true);
  assert.equal(isDeniedPath(join(root, "packages/app/.git/HEAD")), true);
  assert.equal(isDeniedPath(join(root, "node_modules/left-pad/index.js")), true);
  assert.equal(isDeniedPath(join(root, "apps/finance-web/node_modules")), true);
  assert.equal(isDeniedPath(join(root, ".ssh/id_rsa")), true);
  assert.equal(isDeniedPath(join(root, ".aws/credentials")), true);
});

test("isDeniedPath 对普通源码文件不命中", () => {
  const root = makeTempDir();
  assert.equal(isDeniedPath(join(root, "src/index.ts")), false);
  assert.equal(isDeniedPath(join(root, "README.md")), false);
  assert.equal(isDeniedPath(join(root, "package.json")), false);
  assert.equal(isDeniedPath(join(root, "src/support/truncate.ts")), false);
  // 只有名字像 env / 私钥的普通文件不应被误伤
  assert.equal(isDeniedPath(join(root, "src/env-helper.ts")), false);
  assert.equal(isDeniedPath(join(root, "environment.md")), false);
});

test("isDeniedPath 命中无扩展名私钥与 known_hosts（工作区内也拒绝）", () => {
  const root = makeTempDir();
  for (const name of ["id_rsa", "id_ecdsa", "id_ed25519", "id_xmss", "known_hosts", "authorized_keys", "ssh_host_rsa_key"]) {
    assert.equal(isDeniedPath(join(root, "keys/" + name)), true);
    assert.equal(isDeniedPath(join(root, "deploy/" + name)), true);
  }
});

test("isDeniedPath .env 精确匹配、不误伤 .environment / .envoy", () => {
  const root = makeTempDir();
  assert.equal(isDeniedPath(join(root, ".env")), true);
  assert.equal(isDeniedPath(join(root, ".env.local")), true);
  assert.equal(isDeniedPath(join(root, ".env.production")), true);
  assert.equal(isDeniedPath(join(root, ".environment")), false);
  assert.equal(isDeniedPath(join(root, ".envoy.yaml")), false);
});

test("isDeniedPath 空路径视为敏感", () => {
  assert.equal(isDeniedPath(""), true);
});

test("工作区内真实文件：放行越界检查但仍可被敏感规则拒绝", () => {
  const root = makeTempDir();
  writeFileSync(join(root, ".env.local"), "TOKEN=1\n");
  assert.equal(assertPathWithinRoot(join(root, ".env.local"), root).ok, true);
  assert.equal(isDeniedPath(join(root, ".env.local")), true);
});

test("S-P1：read /etc/passwd 越界拒绝且不泄漏内容", async () => {
  const root = makeTempDir();
  assert.equal(assertPathWithinRoot("/etc/passwd", root).ok, false);

  await assert.rejects(
    () => createReadTool(root).execute("call-read-etc", { path: "/etc/passwd" }),
    (error) => {
      assert.equal(error.code, "permission_denied");
      assert.match(error.message, /Read denied/);
      // 拒绝信息只描述策略原因，不能把目标文件内容带进模型上下文
      assert.equal(error.message.includes("root:"), false);
      return true;
    },
  );
});

test("S-P2：write ../outside.txt 拒绝且不落盘", async () => {
  const root = makeTempDir();
  const outsideName = "coding-outside-" + process.pid + ".txt";
  const outsidePath = join(root, "..", outsideName);
  rmSync(outsidePath, { force: true });

  await expectPermissionDenied(createWriteTool(root), { path: "../" + outsideName, content: "should not exist" });
  assert.equal(existsSync(outsidePath), false, "越界写入必须在落盘前被拒绝");
});

test("S-P3：软链指向工作区外时读取拒绝", async () => {
  const root = makeTempDir();
  symlinkSync("/etc", join(root, "link"));

  assert.equal(assertPathWithinRoot(join(root, "link/passwd"), root).ok, false);
  await expectPermissionDenied(createReadTool(root), { path: "link/passwd" });
});

test("S-P4：.env 直读被敏感名规则拒绝", async () => {
  const root = makeTempDir();
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  assert.equal(isDeniedPath(join(root, ".env")), true);
  await expectPermissionDenied(createReadTool(root), { path: ".env" });
});

test("S-P5：软链 foo -> .env 的绕过必须拒绝（realpath 后命中敏感名）", async () => {
  const root = makeTempDir();
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  symlinkSync(join(root, ".env"), join(root, "foo"));

  // 越界检查放行（目标仍在工作区内），但 realpath 后 basename 是 .env，敏感规则必须命中
  assert.equal(assertPathWithinRoot(join(root, "foo"), root).ok, true);
  assert.equal(isDeniedPath(join(root, "foo")), true);
  await expectPermissionDenied(createReadTool(root), { path: "foo" });
});

test("S-P6：敏感目录（node_modules / .git）读取拒绝", async () => {
  const root = makeTempDir();
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "x.js"), "module.exports = 1;\n");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  const read = createReadTool(root);

  assert.equal(isDeniedPath(join(root, "node_modules/x.js")), true);
  assert.equal(isDeniedPath(join(root, ".git/config")), true);
  await expectPermissionDenied(read, { path: "node_modules/x.js" });
  await expectPermissionDenied(read, { path: ".git/config" });
});

test("S-P7：工作区内合法源码路径放行并返回内容", async () => {
  const root = makeTempDir();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n");

  assert.equal(assertPathWithinRoot(join(root, "src/index.ts"), root).ok, true);
  assert.equal(isDeniedPath(join(root, "src/index.ts")), false);

  const result = await createReadTool(root).execute("call-read-source", { path: "src/index.ts" });
  assert.match(result.details.output, /export const answer = 42/);
});

test("D4：悬空软链 write 越界拒绝且不创建链接目标", async () => {
  const root = makeTempDir();
  const outside = mkdtempSync(join(realpathSync(tmpdir()), "coding-outside-"));
  tempDirs.push(outside);
  const target = join(outside, "pwned.txt");
  symlinkSync(target, join(root, "dangle"));

  // canonicalizePath 对不存在的目标只回溯祖先；末级 readlink 才能发现真实落点是工作区外
  assert.equal(assertPathWithinRoot(join(root, "dangle"), root).ok, false);
  await expectPermissionDenied(createWriteTool(root), { path: "dangle", content: "should not exist" });
  assert.equal(existsSync(target), false, "拒绝后不得顺着软链创建目标文件");
});

test("D4：软链 foo -> .env（目标尚不存在）写入拒绝", async () => {
  const root = makeTempDir();
  symlinkSync(".env", join(root, "foo"));

  assert.equal(isDeniedPath(join(root, "foo")), true);
  await expectPermissionDenied(createWriteTool(root), { path: "foo", content: "SECRET=1" });
  assert.equal(existsSync(join(root, ".env")), false, "拒绝后不得创建 .env");
});

test("D4：工作区内普通新文件与指向工作区内的软链不误伤", async () => {
  const root = makeTempDir();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "existing.txt"), "old");

  // 绝对目标与相对目标都指向工作区内，都属于合法写入
  symlinkSync(join(root, "src", "existing.txt"), join(root, "absolute-link"));
  symlinkSync("./src/new.txt", join(root, "relative-link"));

  const write = createWriteTool(root);
  await write.execute("call-write-new", { path: "a/b/new.ts", content: "export const x = 1;\n" });
  await write.execute("call-write-abs-link", { path: "absolute-link", content: "updated" });
  await write.execute("call-write-rel-link", { path: "relative-link", content: "created" });

  assert.equal(existsSync(join(root, "a/b/new.ts")), true);
  assert.equal(existsSync(join(root, "src/new.txt")), true);
});

test("D4：软链循环无法得到稳定目标时拒绝", () => {
  const root = makeTempDir();
  symlinkSync("loop-b", join(root, "loop-a"));
  symlinkSync("loop-a", join(root, "loop-b"));

  const verdict = assertPathWithinRoot(join(root, "loop-a"), root);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /symlink loop/);
  assert.equal(isDeniedPath(join(root, "loop-a")), true);
});
