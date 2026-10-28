import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliArguments } from "./args.js";

/** CLI 所在应用根目录。 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** 仓库根目录。 */
const REPO_ROOT = resolve(APP_ROOT, "../..");

/** doctor 检查项名称。 */
export type DoctorCheckName = "workspace" | "corpus" | "migrations" | "scripts";

/** 单个 doctor 检查结果。 */
export interface DoctorCheck {
  name: DoctorCheckName;
  ok: boolean;
  message: string;
}

/** doctor 聚合结果。 */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * 检查工作区、语料、迁移与根脚本，不执行任何 golden 写操作。
 *
 * @param parsed 已解析的 CLI 参数。
 * @returns 四项独立检查结果。
 */
export async function runDoctor(parsed: CliArguments): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkWorkspace(parsed),
    checkCorpus(parsed),
    checkDirectory(
      "migrations",
      join(REPO_ROOT, "packages", "database", "migrations"),
      "Database migrations are present."
    ),
    checkScripts()
  ]);
  return { ok: checks.every((check) => check.ok), checks };
}

/**
 * 检查工作区根是否存在且可访问。
 *
 * @param parsed CLI 参数。
 * @returns workspace 检查。
 */
async function checkWorkspace(
  parsed: CliArguments
): Promise<DoctorCheck> {
  const root = parsed.workspace
    ? resolve(parsed.workspace)
    : process.env.GOLDEN_WORKSPACE_ROOT
      ? resolve(process.env.GOLDEN_WORKSPACE_ROOT)
      : REPO_ROOT;
  return checkDirectory("workspace", root, "Workspace root is readable.");
}

/**
 * 检查语料 manifest；显式 corpus 与环境变量优先于仓库约定。
 *
 * @param parsed CLI 参数。
 * @returns corpus 检查。
 */
async function checkCorpus(parsed: CliArguments): Promise<DoctorCheck> {
  const root = parsed.corpus
    ? resolve(parsed.corpus)
    : process.env.FINANCE_CORPUS_ROOT
      ? resolve(process.env.FINANCE_CORPUS_ROOT)
      : join(REPO_ROOT, "datasets", "finance");
  return checkFile(
    "corpus",
    join(root, "manifest", "manifest.jsonl"),
    "Corpus manifest is readable."
  );
}

/**
 * 检查目录可读且可遍历。
 *
 * @param name 检查标识。
 * @param path 目录路径。
 * @param successMessage 成功说明。
 * @returns 检查结果。
 */
async function checkDirectory(
  name: DoctorCheckName,
  path: string,
  successMessage: string
): Promise<DoctorCheck> {
  try {
    await access(path, constants.R_OK | constants.X_OK);
    return { name, ok: true, message: successMessage };
  } catch (error) {
    return { name, ok: false, message: `${errorMessage(error)} (${path})` };
  }
}

/**
 * 检查普通文件可读。
 *
 * @param name 检查标识。
 * @param path 文件路径。
 * @param successMessage 成功说明。
 * @returns 检查结果。
 */
async function checkFile(
  name: DoctorCheckName,
  path: string,
  successMessage: string
): Promise<DoctorCheck> {
  try {
    await access(path, constants.R_OK);
    return { name, ok: true, message: successMessage };
  } catch (error) {
    return { name, ok: false, message: `${errorMessage(error)} (${path})` };
  }
}

/**
 * 检查根脚本仍委托给同一个 Golden Studio 应用。
 *
 * @returns scripts 检查。
 */
async function checkScripts(): Promise<DoctorCheck> {
  try {
    const content = await readFile(join(REPO_ROOT, "package.json"), "utf8");
    const packageJson = JSON.parse(content) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = packageJson.scripts ?? {};
    const required = [
      "eval:finance-golden:mine",
      "eval:finance-golden:validate",
      "eval:finance-golden:promote",
      "eval:finance-golden:generate",
      "eval:finance-golden:annotate"
    ];
    const missing = required.filter(
      (name) => typeof scripts[name] !== "string"
    );
    return {
      name: "scripts",
      ok: missing.length === 0,
      message:
        missing.length === 0
          ? "Golden Studio root scripts are registered."
          : `Missing root scripts: ${missing.join(", ")}.`
    };
  } catch (error) {
    return {
      name: "scripts",
      ok: false,
      message: errorMessage(error)
    };
  }
}

/**
 * 安全提取异常说明。
 *
 * @param error 捕获值。
 * @returns 可展示说明。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
