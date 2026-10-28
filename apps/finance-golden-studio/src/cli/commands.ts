import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateEvalDataset } from "../core/generate.js";
import type { MineCandidate } from "../core/mine.js";
import { mineCandidates } from "../core/mine.js";
import { promoteBatch } from "../core/promote.js";
import { validateDraftBatch } from "../core/validate-batch.js";
import { validateGolden } from "../core/validate.js";
import type { WorkspaceConfig } from "../core/workspace.js";
import { resolveWorkspaceConfig } from "../core/workspace.js";
import type { CliArguments } from "./args.js";
import { CliError } from "./args.js";
import { runDoctor } from "./doctor.js";
import { installShutdownSignals, startGoldenStudioServer } from "./serve.js";

/**
 * 分派一个已解析命令。
 *
 * @param parsed CLI 参数。
 * @returns 核心结果或 doctor 报告。
 */
export async function runCommand(parsed: CliArguments): Promise<unknown> {
  switch (parsed.command) {
    case "serve":
      return serve(parsed);
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
 * 启动本地 Web 与 HTTP API，并安装进程信号收尾。
 *
 * @param parsed CLI 参数。
 * @returns 实际监听地址。
 * @throws {CliError} 工作区或监听启动失败时抛出。
 */
async function serve(parsed: CliArguments): Promise<unknown> {
  const handle = await startGoldenStudioServer({
    ...(parsed.workspace || parsed.corpus
      ? { workspaceRoot: parsed.workspace, corpusRoot: parsed.corpus }
      : {})
  });
  installShutdownSignals(handle);
  return { url: handle.url };
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
  return validateDraftBatch(config, parsed.batch as string);
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
 * 判断值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 非数组对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
