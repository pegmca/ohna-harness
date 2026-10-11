// 全仓库 @aiagent/* 依赖声明 vs 实际引用的审计脚本。
// 用法：node test/audit-deps.mjs
// 输出每个包的：声明集合、引用集合、未声明引用（违规）、死依赖（违规）。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 收集所有含 package.json 的工作区目录（packages/*、apps/*）。
function findPackages(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(join(full, "package.json"))) out.push(full);
    // 递归一层（apps、packages 直接放包；storage 等子目录按实际扩展）。
    for (const sub of readdirSync(full)) {
      const subFull = join(full, sub);
      if (statSync(subFull).isDirectory() && existsSync(join(subFull, "package.json"))) {
        out.push(subFull);
      }
    }
  }
  return out;
}

const pkgDirs = findPackages(join(root, "packages")).concat(findPackages(join(root, "apps")));

// 递归收集源码与测试文件。
function collectFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectFiles(full, acc);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const specRe = /["'](@aiagent\/[^"']+)["']/g;

const report = [];
for (const pkgDir of pkgDirs) {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const name = pkgJson.name;
  const declared = new Set();
  for (const sec of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkgJson[sec] || {};
    for (const k of Object.keys(deps)) {
      if (k.startsWith("@aiagent/")) declared.add(k);
    }
  }
  // 实际引用：从源码与测试中提取 @aiagent/<pkg> 顶层名。
  const imported = new Set();
  if (existsSync(join(pkgDir, "src"))) {
    for (const f of collectFiles(join(pkgDir, "src"))) {
      const text = readFileSync(f, "utf8");
      let m;
      while ((m = specRe.exec(text))) {
        const spec = m[1];
        const top = "@aiagent/" + spec.split("/")[1];
        if (top !== name) imported.add(top);
      }
    }
  }
  const undeclared = [...imported].filter((x) => !declared.has(x));
  const dead = [...declared].filter((x) => !imported.has(x));
  report.push({ name, pkgDir, declared: [...declared].sort(), imported: [...imported].sort(), undeclared, dead });
}

let problems = 0;
for (const r of report) {
  const has = r.undeclared.length || r.dead.length;
  if (has) problems++;
  console.log(`\n=== ${r.name} (${r.pkgDir}) ===`);
  console.log(`  声明: ${r.declared.join(", ") || "(无)"}`);
  console.log(`  引用: ${r.imported.join(", ") || "(无)"}`);
  if (r.undeclared.length) {
    console.log(`  [违规-未声明] ${r.undeclared.join(", ")}`);
  }
  if (r.dead.length) {
    console.log(`  [违规-死依赖] ${r.dead.join(", ")}`);
  }
  if (!has) console.log("  OK");
}
console.log(`\n总计 ${report.length} 个包，存在问题的包 ${problems} 个。`);
