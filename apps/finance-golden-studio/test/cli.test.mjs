/**
 * Finance Golden Studio 单一 CLI 入口契约测试。
 *
 * 覆盖子命令分派、严格参数解析、结构化 JSON 输出、稳定错误码与非零退出码；
 * 所有工作区输入均为隔离临时目录，不读写仓库作者集。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  makeGoldenCase,
  makeWorkflowConfig,
  cleanupWorkflowFixtures,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

/** 本测试额外创建的临时目录，统一在 after 钩子中清理。 */
const extraTempDirs = [];
/** 当前 Golden Studio 包根。 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 当前仓库根，由包根稳定推导。 */
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

after(async () => {
  cleanupWorkflowFixtures();
  await Promise.all(
    extraTempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("validate --golden --json 输出唯一 JSON 文档且成功退出", async () => {
  const fixture = await makeResolvedWorkspace({
    pdfText: "Revenue 100"
  });
  const { mineCandidates } = await import("../src/core/mine.ts");
  const { resolveWorkspaceConfig } = await import("../src/core/workspace.ts");
  const { listDrafts, readDraft, saveDraft } = await import(
    "../src/core/drafts.ts"
  );
  const { promoteBatch } = await import("../src/core/promote.ts");
  const config = resolveWorkspaceConfig({
    workspaceRoot: fixture.workspaceRoot,
    corpusRoot: fixture.corpusRoot
  });
  await mineCandidates(config, {
    batch: "candidates",
    candidates: [
      {
        ticker: "002340.SZ",
        report_type: "annual",
        period: "2025",
        type: "negative"
      }
    ]
  });
  const summaries = await listDrafts(config, "candidates");
  const draft = await readDraft(config, "candidates", summaries[0].id);
  await saveDraft(config, "candidates", draft.id, {
    ...draft,
    query: "Does the corpus contain 002340.SZ?",
    gold_answer: "No.",
    note: "CLI fixture",
    _draft: { ...draft._draft, approved: true }
  });
  await promoteBatch(config, "candidates");

  const result = await captureCli([
    "validate",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--golden",
    "--json"
  ]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, true, result.stdout);
  assert.equal(output.command, "validate");
  assert.equal(output.validation.ok, true);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("validate --json 在工作区失败时返回稳定错误码和非零退出码", async () => {
  const fixture = await makeResolvedWorkspace();
  const missingCorpus = join(fixture.workspaceRoot, "missing-corpus");

  const result = await captureCli([
    "validate",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    missingCorpus,
    "--golden",
    "--json"
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.command, "validate");
  assert.equal(output.error, "invalid_root_path");
  assert.match(output.message, /existing directory/i);
});

test("validate --json 对校验 ERROR 返回 validation_failed", async () => {
  const fixture = await makeResolvedWorkspace({
    golden: [{ ...makeGoldenCase(), expected_keywords: [] }],
    pdfText: "Revenue 100"
  });

  const result = await captureCli([
    "validate",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--golden",
    "--json"
  ]);

  assert.equal(result.code, 1);
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.error, "validation_failed");
  assert.equal(output.validation.ok, false);
  assert.equal("result" in output, false);
  assert.ok(
    output.validation.errors.some(
      (issue) => issue.code === "expected_keywords_required"
    )
  );
});

test("mine 从 --candidates 文件读取候选并使用默认批次", async () => {
  const fixture = await makeResolvedWorkspace();
  const candidatesPath = join(fixture.workspaceRoot, "candidates.json");
  await writeFile(
    candidatesPath,
    JSON.stringify([
      {
        ticker: "002340.SZ",
        report_type: "annual",
        period: "2025",
        type: "negative"
      }
    ]),
    "utf8"
  );

  const result = await captureCli([
    "mine",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--candidates",
    candidatesPath,
    "--json"
  ]);

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "mine");
  assert.equal(output.result.batch, "candidates");
  assert.equal(output.result.draftedCount, 1);
});

test("validate --json 接受 candidates 批次并委托同一校验 core", async () => {
  const fixture = await makeResolvedWorkspace({
    pdfText: "Revenue 100"
  });
  const { mineCandidates } = await import("../src/core/mine.ts");
  const { resolveWorkspaceConfig } = await import("../src/core/workspace.ts");
  const config = resolveWorkspaceConfig({
    workspaceRoot: fixture.workspaceRoot,
    corpusRoot: fixture.corpusRoot
  });
  await mineCandidates(config, {
    batch: "candidates",
    candidates: [
      {
        ticker: "002340.SZ",
        report_type: "annual",
        period: "2025",
        type: "negative"
      }
    ]
  });

  const result = await captureCli([
    "validate",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--batch",
    "candidates",
    "--json"
  ]);

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.result.batch, "candidates");
  assert.equal(output.result.draftCount, 1);
});

test("未知子命令、未知选项和位置参数均被拒绝", async () => {
  const cases = [
    [["unknown"], "unknown_command"],
    [["doctor", "extra"], "unexpected_positional"],
    [["doctor", "--unknown"], "unknown_option"],
    [["doctor", "--workspace"], "missing_option_value"],
    [["doctor", "--json", "--json"], "duplicate_option"],
    [["mine"], "missing_option"],
    [["promote"], "missing_option"],
    [["validate", "--batch"], "missing_option_value"],
    [["doctor", "--batch", "b1"], "option_not_allowed"]
  ];

  for (const [argv, code] of cases) {
    const result = await captureCli([...argv, "--json"]);
    assert.equal(result.code, 1, argv.join(" "));
    const output = parseJsonOutput(result.stdout);
    assert.equal(output.ok, false, argv.join(" "));
    assert.equal(output.error, code, argv.join(" "));
  }
});

test("validate 强制选择 --batch 或 --golden 且拒绝两者同时出现", async () => {
  const missing = await captureCli(["validate", "--json"]);
  assert.equal(missing.code, 1);
  assert.equal(parseJsonOutput(missing.stdout).error, "missing_option");

  const conflict = await captureCli([
    "validate",
    "--batch",
    "candidates",
    "--golden",
    "--json"
  ]);
  assert.equal(conflict.code, 1);
  assert.equal(parseJsonOutput(conflict.stdout).error, "option_conflict");
});

test("pnpm 注入的首个 -- 分隔符不影响真实位置参数拒绝", async () => {
  const accepted = await captureCli(["--", "serve", "--json"]);
  assert.equal(accepted.code, 1);
  assert.equal(parseJsonOutput(accepted.stdout).error, "serve_not_implemented");

  const rejected = await captureCli(["--", "doctor", "extra", "--json"]);
  assert.equal(rejected.code, 1);
  assert.equal(
    parseJsonOutput(rejected.stdout).error,
    "unexpected_positional"
  );
});

test("promote 要求 batch 并将 core 结构化错误透传为稳定错误码", async () => {
  const fixture = await makeResolvedWorkspace();

  const result = await captureCli([
    "promote",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--batch",
    "../escape",
    "--json"
  ]);

  assert.equal(result.code, 1);
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.command, "promote");
  assert.equal(output.error, "invalid_batch_name");
});

test("serve 明确报告尚未实现而不会启动服务器", async () => {
  const result = await captureCli(["serve", "--json"]);

  assert.equal(result.code, 1);
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.command, "serve");
  assert.equal(output.error, "serve_not_implemented");
  assert.deepEqual(output.details, { plannedTask: 7 });
});

test("doctor 检查 workspace、corpus、migrations 与 scripts", async () => {
  const fixture = await makeResolvedWorkspace();

  const result = await captureCli([
    "doctor",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--json"
  ]);

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "doctor");
  assert.equal(output.result.ok, true);
  assert.deepEqual(
    output.result.checks.map(({ name, ok }) => ({ name, ok })),
    [
      { name: "workspace", ok: true },
      { name: "corpus", ok: true },
      { name: "migrations", ok: true },
      { name: "scripts", ok: true }
    ]
  );
});

test("doctor 的 JSON 失败结果仍保留每项检查且非零退出", async () => {
  const fixture = await makeResolvedWorkspace({ withManifest: false });

  const result = await captureCli([
    "doctor",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--json"
  ]);

  assert.equal(result.code, 1);
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.error, "doctor_failed");
  assert.deepEqual(
    output.result.checks.map(({ name, ok }) => ({ name, ok })),
    [
      { name: "workspace", ok: true },
      { name: "corpus", ok: false },
      { name: "migrations", ok: true },
      { name: "scripts", ok: true }
    ]
  );
});

test("doctor 将格式损坏的 manifest 报告为结构化 corpus 失败", async () => {
  const fixture = await makeResolvedWorkspace();
  await writeFile(
    join(fixture.corpusRoot, "manifest", "manifest.jsonl"),
    "{not-json}\n",
    "utf8"
  );

  const result = await captureCli([
    "doctor",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--json"
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.error, "doctor_failed");
  const corpus = output.result.checks.find((check) => check.name === "corpus");
  assert.deepEqual(
    {
      ok: corpus?.ok,
      errorCode: corpus?.errorCode,
      line: corpus?.line
    },
    { ok: false, errorCode: "manifest_json_invalid", line: 1 }
  );
});

test("doctor 将重复 manifest 三元组报告为结构化 corpus 失败", async () => {
  const fixture = await makeResolvedWorkspace();
  const record = {
    ticker: "600000.SH",
    report_type: "annual",
    period: "2025",
    file_path: "raw/cn/600000.SH/2025.pdf"
  };
  await writeFile(
    join(fixture.corpusRoot, "manifest", "manifest.jsonl"),
    `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`,
    "utf8"
  );

  const result = await captureCli([
    "doctor",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot,
    "--json"
  ]);

  assert.equal(result.code, 1);
  const output = parseJsonOutput(result.stdout);
  const corpus = output.result.checks.find((check) => check.name === "corpus");
  assert.deepEqual(
    {
      ok: corpus?.ok,
      errorCode: corpus?.errorCode,
      line: corpus?.line
    },
    { ok: false, errorCode: "manifest_triple_duplicate", line: 2 }
  );
});

test("doctor scripts 检查拒绝指向其他应用或入口的脚本", async () => {
  const repoRoot = await makeDoctorRepoFixture({
    scripts: {
      "golden-studio": "node --import tsx other-app/src/cli/main.ts",
      "eval:finance-golden:mine": "pnpm golden-studio mine",
      "eval:finance-golden:validate": "pnpm golden-studio validate",
      "eval:finance-golden:promote": "pnpm golden-studio promote",
      "eval:finance-golden:generate": "pnpm golden-studio generate",
      "eval:finance-golden:annotate": "pnpm golden-studio serve"
    }
  });
  const { runDoctor } = await import("../src/cli/doctor.ts");
  const report = await runDoctor(
    {
      command: "doctor",
      json: true,
      golden: false
    },
    repoRoot
  );

  assert.equal(report.ok, false);
  const scripts = report.checks.find((check) => check.name === "scripts");
  assert.equal(scripts?.ok, false);
  assert.match(scripts?.message ?? "", /golden-studio|entrypoint/i);
});

test("doctor scripts 检查接受全部兼容脚本委托单一 Golden Studio 入口", async () => {
  const repoRoot = await makeDoctorRepoFixture();
  const { runDoctor } = await import("../src/cli/doctor.ts");
  const report = await runDoctor(
    {
      command: "doctor",
      json: true,
      golden: false
    },
    repoRoot
  );

  assert.equal(report.ok, true, JSON.stringify(report.checks));
  const scripts = report.checks.find((check) => check.name === "scripts");
  assert.equal(scripts?.ok, true, scripts?.message);
});

test("doctor scripts 检查拒绝通过其他脚本间接运行的入口", async () => {
  const repoRoot = await makeDoctorRepoFixture({
    scripts: {
      "golden-studio":
        "pnpm --silent exec sh apps/finance-golden-studio/src/cli/main.ts",
      "eval:finance-golden:mine": "pnpm --silent golden-studio mine",
      "eval:finance-golden:validate": "pnpm --silent golden-studio validate",
      "eval:finance-golden:promote": "pnpm --silent golden-studio promote",
      "eval:finance-golden:generate": "pnpm --silent golden-studio generate",
      "eval:finance-golden:annotate": "pnpm --silent golden-studio serve"
    }
  });
  const { runDoctor } = await import("../src/cli/doctor.ts");
  const report = await runDoctor(
    {
      command: "doctor",
      json: true,
      golden: false
    },
    repoRoot
  );

  const scripts = report.checks.find((check) => check.name === "scripts");
  assert.equal(scripts?.ok, false);
  assert.match(scripts?.message ?? "", /must equal.*main\.ts/i);
});

test("pnpm golden-studio doctor --json 只输出一个 JSON 文档", async () => {
  const fixture = await makeResolvedWorkspace();
  const result = await captureProcess(
    "pnpm",
    [
      "--silent",
      "golden-studio",
      "doctor",
      "--workspace",
      fixture.workspaceRoot,
      "--corpus",
      fixture.corpusRoot,
      "--json"
    ],
    REPO_ROOT
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "doctor");
});

test("兼容 scripts 原样递归运行唯一入口以保留参数转发", async () => {
  const scripts = await readPackageJsonScripts(REPO_ROOT);

  assert.equal(
    scripts["golden-studio"],
    "pnpm --silent exec node --import tsx apps/finance-golden-studio/src/cli/main.ts"
  );
  assert.equal(
    scripts["eval:finance-golden:validate"],
    "pnpm --silent golden-studio validate"
  );
  assert.equal(
    scripts["eval:finance-golden:mine"],
    "pnpm --silent golden-studio mine"
  );
});

test("兼容 validate 脚本正确转发 --golden、--workspace 与 --corpus", async () => {
  const fixture = await makeResolvedWorkspace({
    golden: [makeGoldenCase()],
    pdfText: "Revenue 100"
  });
  const result = await captureProcess(
    "pnpm",
    [
      "--silent",
      "eval:finance-golden:validate",
      "--workspace",
      fixture.workspaceRoot,
      "--corpus",
      fixture.corpusRoot,
      "--golden",
      "--json"
    ],
    REPO_ROOT
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "validate");
  assert.equal(output.result.validation.ok, true);
});

test("兼容 mine 脚本正确转发 --candidates、--batch 与 --corpus", async () => {
  const fixture = await makeResolvedWorkspace();
  const candidatesPath = join(fixture.workspaceRoot, "compat-candidates.json");
  await writeFile(
    candidatesPath,
    JSON.stringify([
      {
        ticker: "002340.SZ",
        report_type: "annual",
        period: "2025",
        type: "negative"
      }
    ]),
    "utf8"
  );
  const result = await captureProcess(
    "pnpm",
    [
      "--silent",
      "eval:finance-golden:mine",
      "--workspace",
      fixture.workspaceRoot,
      "--corpus",
      fixture.corpusRoot,
      "--candidates",
      candidatesPath,
      "--batch",
      "compat-batch",
      "--json"
    ],
    REPO_ROOT
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const output = parseJsonOutput(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "mine");
  assert.equal(output.result.batch, "compat-batch");
  assert.equal(output.result.draftedCount, 1);
});

test("不带 --json 时成功输出人类文本并在失败时使用 stderr", async () => {
  const fixture = await makeResolvedWorkspace();
  const success = await captureCli([
    "doctor",
    "--workspace",
    fixture.workspaceRoot,
    "--corpus",
    fixture.corpusRoot
  ]);
  assert.equal(success.code, 0);
  assert.match(success.stdout, /^ok workspace:/);
  assert.equal(success.stderr, "");

  const invalid = await captureCli(["doctor", "positional"]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /unexpected_positional/);

  const noJsonFailure = await captureCli(["serve"]);
  assert.equal(noJsonFailure.code, 1);
  assert.equal(noJsonFailure.stdout, "");
  assert.match(noJsonFailure.stderr, /serve_not_implemented/);
});

/**
 * 捕获 runCli 的 stdout/stderr，且不依赖测试进程真实管道。
 *
 * @param {string[]} argv CLI 参数（不含 node 和脚本路径）。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 执行结果。
 */
async function captureCli(argv) {
  const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...argv], {
      cwd: fileURLToPath(new URL("..", import.meta.url))
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * 在指定工作目录启动真实子进程并捕获输出。
 *
 * @param {string} command 可执行文件。
 * @param {string[]} argv 参数。
 * @param {string} cwd 工作目录。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 执行结果。
 */
async function captureProcess(command, argv, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * 读取 package scripts。
 *
 * @param {string} root 仓库根。
 * @returns {Promise<Record<string, string>>} scripts 映射。
 */
async function readPackageJsonScripts(root) {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8")
  );
  return packageJson.scripts ?? {};
}

/**
 * 验证输出为空或恰好一个 JSON 文档。
 *
 * @param {string} stdout 捕获的标准输出。
 * @returns {any} 解析后的 JSON。
 */
function parseJsonOutput(stdout) {
  assert.notEqual(stdout.trim(), "",
    "expected structured output, received empty stdout");
  assert.equal(stdout.trim().split("\n").length, 1, stdout);
  return JSON.parse(stdout);
}

/**
 * 创建可被 CLI 重新解析的隔离工作区和语料根。
 *
 * @param {{golden?: object[], pdfText?: string, withManifest?: boolean}} input 测试输入。
 * @returns {Promise<{workspaceRoot: string, corpusRoot: string}>} 显式 CLI 根。
 */
async function makeResolvedWorkspace(input = {}) {
  const config = makeWorkflowConfig();
  const workspaceRoot = await realpath(config.workspaceRoot);
  const corpusRoot = await realpath(config.corpusRoot);

  if (input.withManifest !== false) {
    writeManifest(config, [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        file_path: "raw/cn/600000.SH/2025.pdf",
        disclosure_date: "2026-01-01"
      }
    ]);
    writePdf(config, "raw/cn/600000.SH/2025.pdf", input.pdfText ?? "Revenue 100");
  }

  const goldenRoot = join(workspaceRoot, "datasets", "finance", "rag-golden");
  await mkdir(goldenRoot, { recursive: true });
  const golden = input.golden ?? [];
  await writeFile(
    join(goldenRoot, "golden.jsonl"),
    golden.length > 0
      ? `${golden.map((record) => JSON.stringify(record)).join("\n")}\n`
      : "",
    "utf8"
  );

  return { workspaceRoot, corpusRoot };
}

/**
 * 创建仅包含 doctor 所需目录与 package scripts 的仓库夹具。
 *
 * @param {{scripts?: Record<string, string>}} input 脚本覆盖。
 * @returns {Promise<string>} 临时仓库根。
 */
async function makeDoctorRepoFixture(input = {}) {
  const repoRoot = await mkdtemp(join(await realpath(tmpdir()), "golden-doctor-"));
  extraTempDirs.push(repoRoot);
  const appRoot = join(repoRoot, "apps", "finance-golden-studio");
  await mkdir(join(appRoot, "src", "cli"), { recursive: true });
  await mkdir(join(repoRoot, "packages", "database", "migrations"), {
    recursive: true
  });
  await mkdir(join(repoRoot, "datasets", "finance", "manifest"), {
    recursive: true
  });
  await writeFile(
    join(repoRoot, "datasets", "finance", "manifest", "manifest.jsonl"),
    "",
    "utf8"
  );
  await writeFile(
    join(appRoot, "src", "cli", "main.ts"),
    "export {};\n",
    "utf8"
  );
  const scripts = input.scripts ?? {
    "golden-studio":
      "pnpm --silent exec node --import tsx apps/finance-golden-studio/src/cli/main.ts",
    "eval:finance-golden:mine": "pnpm --silent golden-studio mine",
    "eval:finance-golden:validate": "pnpm --silent golden-studio validate",
    "eval:finance-golden:promote": "pnpm --silent golden-studio promote",
    "eval:finance-golden:generate": "pnpm --silent golden-studio generate",
    "eval:finance-golden:annotate": "pnpm --silent golden-studio serve"
  };
  await writeFile(
    join(repoRoot, "package.json"),
    JSON.stringify({ scripts }, null, 2),
    "utf8"
  );
  return repoRoot;
}
