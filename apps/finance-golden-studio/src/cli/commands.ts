import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listDrafts } from "../core/drafts.js";
import { GoldenStudioError } from "../core/errors.js";
import { generateEvalDataset } from "../core/generate.js";
import type { MineCandidate } from "../core/mine.js";
import { mineCandidates } from "../core/mine.js";
import { promoteBatch } from "../core/promote.js";
import type { ValidationReport } from "../core/schema.js";
import type { GoldenDraft } from "../core/types.js";
import { validateDraft, validateGolden } from "../core/validate.js";
import type { WorkspaceConfig } from "../core/workspace.js";
import {
  resolveWorkspaceConfig,
  validateBatchName
} from "../core/workspace.js";
import type { CliArguments } from "./args.js";
import { CliError } from "./args.js";
import { runDoctor } from "./doctor.js";

/**
 * 分派一个已解析命令。
 *
 * @param parsed CLI 参数。
 * @returns 核心结果或 doctor 报告。
 */
export async function runCommand(parsed: CliArguments): Promise<unknown> {
  switch (parsed.command) {
    case "serve":
      throw new CliError(
        "serve_not_implemented",
        "The local Golden Studio server is not available yet.",
        { plannedTask: 7 }
      );
    case "doctor":
      return runDoctor(parsed);
    case "mine":
      return mine(parsed);
    case "validate":
      return validate(parsed);
    case "promote":
      return promote(parsed);
    case "generate":
      return generate(parsed);
  }
}

/**
 * 解析工作区配置。
 *
 * @param parsed CLI 参数。
 * @returns core 工作区配置。
 */
function resolveConfig(parsed: CliArguments): WorkspaceConfig {
  return resolveWorkspaceConfig({
    ...(parsed.workspace ? { workspaceRoot: resolve(parsed.workspace) } : {}),
    ...(parsed.corpus ? { corpusRoot: resolve(parsed.corpus) } : {})
  });
}

/**
 * 读取候选并调用 mine core。
 *
 * @param parsed CLI 参数。
 * @returns mine 工作流报告。
 */
async function mine(parsed: CliArguments): Promise<unknown> {
  return mineCandidates(resolveConfig(parsed), {
    batch: parsed.batch ?? "candidates",
    candidates: await readCandidates(parsed.candidates as string)
  });
}

/**
 * 读取候选 JSON 数组。
 *
 * @param path 候选文件路径。
 * @returns 待交给 core 做字段诊断的候选对象。
 * @throws {CliError} 文件不可读、JSON 非法或不是对象数组时抛出。
 */
async function readCandidates(path: string): Promise<MineCandidate[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new CliError(
      "candidates_invalid",
      `Candidates file cannot be read as JSON: ${path}.`,
      { path },
      error
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new CliError(
      "candidates_invalid",
      "Candidates file must contain an array of objects.",
      { path }
    );
  }
  return parsed as unknown as MineCandidate[];
}

/**
 * 校验作者集或一个草稿批次。
 *
 * @param parsed CLI 参数。
 * @returns 校验信封。
 */
async function validate(parsed: CliArguments): Promise<unknown> {
  const config = resolveConfig(parsed);
  if (parsed.golden) {
    return { validation: await validateGolden(config) };
  }
  return validateBatch(config, parsed.batch as string);
}

/**
 * 读取批次草稿并逐条调用 validateDraft。
 *
 * @param config 工作区配置。
 * @param batch 批次名。
 * @returns 批次校验信封。
 */
async function validateBatch(
  config: WorkspaceConfig,
  batch: string
): Promise<unknown> {
  validateBatchName(batch);
  const summaries = await listDrafts(config, batch);
  if (summaries.length === 0) {
    throw new CliError(
      "drafts_not_found",
      `Draft batch not found or empty: ${batch}.`,
      { batch }
    );
  }
  const reports: ValidationReport[] = [];
  for (const summary of summaries) {
    if (summary.corrupt) {
      throw new GoldenStudioError(
        "draft_corrupt",
        `Batch ${batch} contains corrupt draft ${summary.id}.`,
        { batch, id: summary.id }
      );
    }
    const draft = await readDraftFile(config, batch, summary.id);
    reports.push(await validateDraft(config, draft));
  }
  const validation = mergeReports(reports);
  return { batch, draftCount: summaries.length, validation };
}

/**
 * 读取一个已经由 listDrafts 枚举的草稿。
 *
 * @param config 工作区配置。
 * @param batch 批次名。
 * @param id 草稿 ID。
 * @returns 草稿对象。
 */
async function readDraftFile(
  config: WorkspaceConfig,
  batch: string,
  id: string
): Promise<GoldenDraft> {
  const path = join(config.draftRoot, batch, `${id}.jsonl`);
  return JSON.parse(await readFile(path, "utf8")) as GoldenDraft;
}

/**
 * 发布一个审核批次。
 *
 * @param parsed CLI 参数。
 * @returns promote 报告。
 */
async function promote(parsed: CliArguments): Promise<unknown> {
  return promoteBatch(resolveConfig(parsed), parsed.batch as string);
}

/**
 * 生成评测数据集，并避免把完整 base64 数据集重复打印到终端。
 *
 * @param parsed CLI 参数。
 * @returns 带数据集摘要的 generate 报告。
 */
async function generate(parsed: CliArguments): Promise<unknown> {
  const report = await generateEvalDataset(resolveConfig(parsed));
  return {
    ...report,
    dataset: {
      ...report.dataset,
      cases: report.dataset.cases.length
    }
  };
}

/**
 * 合并多个草稿校验报告。
 *
 * @param reports 单草稿报告。
 * @returns 统一 ValidationReport。
 */
function mergeReports(reports: readonly ValidationReport[]): ValidationReport {
  const errors = reports.flatMap((report) => report.errors);
  const warnings = reports.flatMap((report) => report.warnings);
  const keywordResults = reports.flatMap((report) => report.keywordResults);
  return { ok: errors.length === 0, errors, warnings, keywordResults };
}

/**
 * 判断值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 非数组对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
