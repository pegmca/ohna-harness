/**
 * path-policy.ts 单元测试：越界判定与敏感路径判定。
 *
 * 用例刻意使用 os.tmpdir() 下的真实临时目录（并 realpath 规范化），
 * 因为 macOS 的 tmpdir 是软链，不规范化会让「工作区内放行」与「相邻目录拒绝」两种断言失去意义。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPathWithinRoot, isDeniedPath } from "../dist/policy/path-policy.js";

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
  assert.equal(isDeniedPath(join(root, "apps/web/node_modules")), true);
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
