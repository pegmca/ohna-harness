/**
 * Finance Golden Studio 迁移与端到端工作流测试。
 *
 * 作者集、manifest、最小 PDF 与生成物都在隔离临时目录中走真实 core/CLI；
 * 仓库作者集只做只读契约检查，避免测试依赖或改写开发者私有语料。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeGolden,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

/** 测试包根。 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 仓库根。 */
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
/** 仓库真实作者集。 */
const AUTHORED_GOLDEN = join(
  REPO_ROOT,
  "datasets",
  "finance",
  "rag-golden",
  "golden.jsonl"
);
/** 测试额外临时目录。 */
const tempDirs = [];

after(async () => {
  cleanupWorkflowFixtures();
  await Promise.all(
    tempDirs.map((directory) =>
      rmSync(directory, { recursive: true, force: true })
    )
  );
});

test("迁移后旧脚本与旧标注页已删除且包入口不引用它们", () => {
  const removed = [
    "test/mine-finance-golden.mjs",
    "test/validate-finance-golden.mjs",
    "test/promote-finance-golden.mjs",
    "test/generate-finance-golden-v1.mjs",
    "test/annotate-finance-golden.mjs",
    "test/annotate-finance-golden.html"
  ];
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8")
  );
  const activeText = [
    readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
    readFileSync(join(REPO_ROOT, "apps", "finance-golden-studio", "README.md"), "utf8"),
    readFileSync(join(REPO_ROOT, "datasets", "finance", "rag-golden", "SCHEMA.md"), "utf8"),
    readFileSync(join(REPO_ROOT, "datasets", "finance", "rag-golden", "TAXONOMY.md"), "utf8"),
    readFileSync(join(REPO_ROOT, "docs", "v2.0", "02-eval-system-v2.md"), "utf8"),
    readFileSync(
      join(REPO_ROOT, "docs", "v2.1", "02-finance-rag-table-recall.md"),
      "utf8"
    ),
    JSON.stringify(packageJson)
  ].join("\n");

  for (const path of removed) {
    assert.equal(existsSync(join(REPO_ROOT, path)), false, path);
    assert.equal(activeText.includes(path), false, path);
  }
  assert.equal(activeText.includes("golden-studio"), true);
});

test("根兼容脚本仍委托唯一 CLI 且可按参数追加选项", () => {
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8")
  );
  assert.deepEqual(
    {
      mine: packageJson.scripts["eval:finance-golden:mine"],
      annotate: packageJson.scripts["eval:finance-golden:annotate"],
      validate: packageJson.scripts["eval:finance-golden:validate"],
      promote: packageJson.scripts["eval:finance-golden:promote"],
      generate: packageJson.scripts["eval:finance-golden:generate"]
    },
    {
      mine: "pnpm golden-studio mine",
      annotate: "pnpm golden-studio serve",
      validate: "pnpm golden-studio validate",
      promote: "pnpm golden-studio promote",
      generate: "pnpm golden-studio generate"
    }
  );
  assert.equal("golden-studio" in packageJson.scripts, false);
});

test("README 记录一键启动、单一 CLI、环境变量与完整工作流", () => {
  const readme = readFileSync(
    join(REPO_ROOT, "apps", "finance-golden-studio", "README.md"),
    "utf8"
  );
  for (const command of [
    "pnpm --filter @aiagent/finance-golden-studio dev",
    "pnpm golden-studio serve",
    "pnpm golden-studio mine --candidates",
    "pnpm golden-studio validate --batch",
    "pnpm golden-studio promote --batch",
    "pnpm golden-studio validate --golden",
    "pnpm golden-studio generate",
    "pnpm eval:finance-golden"
  ]) {
    assert.equal(readme.includes(command), true, command);
  }
  for (const variable of ["FINANCE_CORPUS_ROOT", "GOLDEN_WORKSPACE_ROOT"]) {
    assert.equal(readme.includes(variable), true, variable);
  }
  assert.match(
    readme,
    /mine\s*→\s*annotate\s*→\s*validate\s*→\s*promote\s*→\s*generate\s*→\s*eval/
  );
  assert.match(readme, /expected_keywords/);
});

test("当前 14 条作者记录可导入且 13 条正例题都有非空 expected_keywords", () => {
  const records = readGoldenJsonl(AUTHORED_GOLDEN);

  assert.equal(records.length, 14);
  assert.deepEqual(
    records.map((record) => record.id),
    Array.from({ length: 14 }, (_, index) => `fin-${String(index + 1).padStart(3, "0")}`)
  );
  for (const record of records) {
    if (record.is_negative === true) {
      assert.equal(record.type, "negative");
      assert.equal("expected_keywords" in record, false);
      continue;
    }
    assert.equal(Array.isArray(record.expected_keywords), true, record.id);
    assert.ok(record.expected_keywords.length > 0, record.id);
    assert.ok(
      record.expected_keywords.every(
        (keyword) => typeof keyword === "string" && keyword.trim().length > 0
      ),
      record.id
    );
  }
});

test("真实 14 条作者集通过统一 validate 路径且生成物传播 same keywords", async () => {
  const authoring = makeFixtureFromAuthoredGolden();
  const { resolveWorkspaceConfig } = await import("../src/core/workspace.ts");
  const { validateGolden } = await import("../src/core/validate.ts");
  const { generateEvalDataset } = await import("../src/core/generate.ts");
  const config = resolveWorkspaceConfig({
    workspaceRoot: authoring.workspaceRoot,
    corpusRoot: authoring.corpusRoot
  });

  const validation = await validateGolden(config);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);

  const report = await generateEvalDataset(config);
  assert.equal(report.ok, true, JSON.stringify(report.validation.errors));
  assert.equal(report.caseCount, 14);
  const generated = JSON.parse(readFileSync(config.generatedPath, "utf8"));
  const authored = new Map(
    readGoldenJsonl(config.goldenPath).map((record) => [record.id, record])
  );
  assert.equal(generated.cases.length, 14);
  for (const evaluationCase of generated.cases) {
    assert.deepEqual(
      evaluationCase.expectedKeywords,
      authored.get(evaluationCase.id).expected_keywords ?? []
    );
  }
});

test("mine 与 validate 在真实 CLI 参数下走通草稿修改闭环", async () => {
  const fixture = makeWorkflowConfig();
  const pdfPath = "600000.SH/annual/2025.pdf";
  writeManifest(fixture, [
    {
      ticker: "600000.SH",
      report_type: "annual",
      period: "2025",
      file_path: pdfPath
    }
  ]);
  writePdf(fixture, pdfPath, "Revenue 100. COMPAT-KEYWORD. ".repeat(12));
  writeGolden(fixture, []);
  const candidates = join(fixture.workspaceRoot, "compat-candidates.json");
  writeFileSync(
    candidates,
    JSON.stringify([
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        type: "numeric_fact"
      }
    ])
  );

  const mined = await capture(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PACKAGE_ROOT, "src", "cli", "main.ts"),
      "mine",
      "--candidates",
      candidates,
      "--batch",
      "compat",
      "--workspace",
      fixture.workspaceRoot,
      "--corpus",
      fixture.corpusRoot,
      "--json"
    ],
    PACKAGE_ROOT
  );
  assert.equal(mined.code, 0, mined.stdout + mined.stderr);
  const mineOutput = parseSingleJson(mined.stdout);
  assert.equal(mineOutput.command, "mine");
  assert.equal(mineOutput.result.draftedCount, 1);

  const draftPath = join(
    fixture.draftRoot,
    "compat",
    "fin-D001.jsonl"
  );
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  writeFileSync(
    draftPath,
    `${JSON.stringify({
      ...draft,
      query: "What was revenue?",
      gold_answer: "Revenue was 100.",
      answer_unit: "currency",
      evidence: [
        {
          ...draft.evidence[0],
          section: "Financial highlights",
          quote: "COMPAT-KEYWORD"
        }
      ],
      expected_keywords: ["COMPAT-KEYWORD"],
      _draft: { ...draft._draft, approved: true }
    })}\n`
  );

  const validated = await capture(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PACKAGE_ROOT, "src", "cli", "main.ts"),
      "validate",
      "--batch",
      "compat",
      "--workspace",
      fixture.workspaceRoot,
      "--corpus",
      fixture.corpusRoot,
      "--json"
    ],
    PACKAGE_ROOT
  );
  assert.equal(validated.code, 0, validated.stdout + validated.stderr);
  const validateOutput = parseSingleJson(validated.stdout);
  assert.equal(validateOutput.command, "validate");
  assert.equal(validateOutput.validation.ok, true);
});

test("standalone serve 结构化报告缺失语料且不启动半成品服务", async () => {
  const fixture = makeWorkflowConfig();
  rmSync(fixture.manifestPath, { force: true });
  const result = await capture(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PACKAGE_ROOT, "src", "cli", "main.ts"),
      "serve",
      "--workspace",
      fixture.workspaceRoot,
      "--corpus",
      fixture.corpusRoot,
      "--json"
    ],
    PACKAGE_ROOT
  );

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const output = parseSingleJson(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.command, "serve");
  assert.equal(output.error, "serve_startup_failed");
  assert.equal(output.details.stage, "workspace");
});

/**
 * 读取 JSONL 作者集。
 *
 * @param path JSONL 路径。
 * @returns 解析后的记录。
 */
function readGoldenJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * 用真实作者集和临时 manifest/PDF 构造可完整校验的工作区。
 *
 * @returns {{workspaceRoot: string, corpusRoot: string}} 工作区根。
 */
function makeFixtureFromAuthoredGolden() {
  const fixture = makeWorkflowConfig();
  const records = readGoldenJsonl(AUTHORED_GOLDEN);
  const fixtureRecords = records.map((record) => ({
    ...record,
    ...(record.is_negative
      ? {}
      : { expected_keywords: ["Fixture evidence source."] })
  }));
  const manifest = [];
  const created = new Set();
  for (const record of fixtureRecords) {
    for (const evidence of record.evidence ?? []) {
      const key = `${evidence.ticker}/${evidence.report_type}/${evidence.period}`;
      if (created.has(key)) continue;
      created.add(key);
      const filePath = `raw/${key}.pdf`;
      manifest.push({
        ticker: evidence.ticker,
        report_type: evidence.report_type,
        period: evidence.period,
        file_path: filePath,
        disclosure_date: disclosureDateFor(evidence)
      });
      writePdf(
        fixture,
        filePath,
        fixtureRecords
          .filter((candidate) =>
            (candidate.evidence ?? []).some(
              (candidateEvidence) =>
                candidateEvidence.ticker === evidence.ticker &&
                candidateEvidence.report_type === evidence.report_type &&
                candidateEvidence.period === evidence.period
            )
          )
          .flatMap((candidate) => candidate.expected_keywords ?? [])
          .join(" ")
          .repeat(2)
          .concat(" Fixture evidence source.")
      );
    }
  }
  writeManifest(fixture, manifest);
  const internalPattern = join(
    fixture.workspaceRoot,
    "dataset-template",
    "internal-note.md"
  );
  mkdirSync(dirname(internalPattern), { recursive: true });
  writeFileSync(
    internalPattern,
    "# Internal annotation pattern\n\nExpected keywords are human-confirmed source anchors.\n"
  );
  writeGolden(fixture, fixtureRecords);
  return fixture;
}

/**
 * 为 latest_by fixtures 提供稳定的披露日期。
 *
 * @param evidence 真实作者集来源。
 * @returns ISO 日期。
 */
function disclosureDateFor(evidence) {
  if (evidence.ticker === "000963.SZ" && evidence.period === "2026H1") {
    return "2026-08-27";
  }
  if (evidence.ticker === "000963.SZ" && evidence.period === "2025") {
    return "2026-03-01";
  }
  if (evidence.ticker === "000963.SZ" && evidence.period === "2024") {
    return "2025-01-01";
  }
  if (evidence.ticker === "601888.SH" && evidence.period === "2026H1") {
    return "2026-08-21";
  }
  if (evidence.ticker === "603501.SH" && evidence.period === "2025") {
    return "2026-01-01";
  }
  if (evidence.ticker === "603501.SH" && evidence.period === "2024") {
    return "2025-01-01";
  }
  return "2026-01-01";
}

/**
 * 在指定工作目录运行真实子进程。
 *
 * @param command 可执行文件。
 * @param argv 参数。
 * @param cwd 工作目录。
 * @param timeoutMs 超时毫秒。
 * @returns 退出码与输出。
 */
function capture(command, argv, cwd, timeoutMs = 20_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out: ${command} ${argv.join(" ")}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * 解析唯一的 CLI JSON 文档。
 *
 * @param stdout 标准输出。
 * @returns JSON 对象。
 */
function parseSingleJson(stdout) {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, stdout);
  return JSON.parse(lines[0]);
}
