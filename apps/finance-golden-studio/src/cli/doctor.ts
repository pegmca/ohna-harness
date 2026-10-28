import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../core/manifest.js";
import { resolveWorkspaceConfig } from "../core/workspace.js";
import type { CliArguments } from "./args.js";

/** CLI 所在应用根目录。 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** 仓库根目录。 */
const REPO_ROOT = resolve(APP_ROOT, "../..");
/** 唯一 CLI 入口的精确根脚本定义。 */
const GOLDEN_STUDIO_SCRIPT =
  "pnpm --silent exec node --import tsx apps/finance-golden-studio/src/cli/main.ts";

/** doctor 检查项名称。 */
export type DoctorCheckName = "workspace" | "corpus" | "migrations" | "scripts";

/** 单个 doctor 检查结果。 */
export interface DoctorCheck {
  name: DoctorCheckName;
  ok: boolean;
  message: string;
  errorCode?: string;
  line?: number;
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
 * @param repoRoot 可选的仓库根覆盖，仅供测试隔离使用。
 * @returns 四项独立检查结果。
 */
export async function runDoctor(
  parsed: CliArguments,
  repoRoot = REPO_ROOT
): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkWorkspace(parsed, repoRoot),
    checkCorpus(parsed, repoRoot),
    checkDirectory(
      "migrations",
      join(repoRoot, "packages", "database", "migrations"),
      "Database migrations are present."
    ),
    checkScripts(repoRoot)
  ]);
  return { ok: checks.every((check) => check.ok), checks };
}

/**
 * 检查工作区根是否存在且可访问。
 *
 * @param parsed CLI 参数。
 * @param repoRoot 仓库根。
 * @returns workspace 检查。
 */
async function checkWorkspace(
  parsed: CliArguments,
  repoRoot: string
): Promise<DoctorCheck> {
  const root = parsed.workspace
    ? resolve(parsed.workspace)
    : process.env.GOLDEN_WORKSPACE_ROOT
      ? resolve(process.env.GOLDEN_WORKSPACE_ROOT)
      : repoRoot;
  return checkDirectory("workspace", root, "Workspace root is readable.");
}

/**
 * 检查语料 manifest；显式 corpus 与环境变量优先于仓库约定。
 *
 * @param parsed CLI 参数。
 * @param repoRoot 仓库根。
 * @returns corpus 检查。
 */
async function checkCorpus(
  parsed: CliArguments,
  repoRoot: string
): Promise<DoctorCheck> {
  const root = parsed.corpus
    ? resolve(parsed.corpus)
    : process.env.FINANCE_CORPUS_ROOT
      ? resolve(process.env.FINANCE_CORPUS_ROOT)
      : join(repoRoot, "datasets", "finance");
  try {
    const config = resolveWorkspaceConfig({
      workspaceRoot: parsed.workspace ?? repoRoot,
      corpusRoot: root
    });
    const manifest = await readManifest(config);
    if (manifest.errors.length === 0) {
      return {
        name: "corpus",
        ok: true,
        message: "Corpus manifest is valid."
      };
    }
    const first = manifest.errors[0];
    return {
      name: "corpus",
      ok: false,
      message: first.message,
      errorCode: first.code,
      ...(first.line === undefined ? {} : { line: first.line })
    };
  } catch (error) {
    return {
      name: "corpus",
      ok: false,
      message: `${errorMessage(error)} (${join(root, "manifest", "manifest.jsonl")})`
    };
  }
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
 * 检查根脚本仍委托给单一 Golden Studio CLI 入口。
 *
 * @param repoRoot 仓库根。
 * @returns scripts 检查。
 */
async function checkScripts(repoRoot: string): Promise<DoctorCheck> {
  try {
    const content = await readFile(join(repoRoot, "package.json"), "utf8");
    const packageJson = JSON.parse(content) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = packageJson.scripts ?? {};
    const missing = scriptRequirements
      .filter(({ name }) => typeof scripts[name] !== "string")
      .map(({ name }) => name);
    if (missing.length > 0) {
      return {
        name: "scripts",
        ok: false,
        message: `Missing root scripts: ${missing.join(", ")}.`
      };
    }
    const mainScript = scripts["golden-studio"] as string;
    if (mainScript !== GOLDEN_STUDIO_SCRIPT) {
      return {
        name: "scripts",
        ok: false,
        message: `Root golden-studio script must equal: ${GOLDEN_STUDIO_SCRIPT}`
      };
    }
    const mismatched = scriptRequirements
      .filter(
        ({ name, command }) =>
          !delegatesToGoldenStudio(scripts[name] as string, command)
      )
      .map(({ name }) => name);
    return {
      name: "scripts",
      ok: mismatched.length === 0,
      message:
        mismatched.length === 0
          ? "Golden Studio root scripts use the single CLI entry."
          : `Scripts do not target the single Golden Studio entry: ${mismatched.join(", ")}.`
    };
  } catch (error) {
    return {
      name: "scripts",
      ok: false,
      message: errorMessage(error)
    };
  }
}

/** 根脚本名及其必须转发的 Golden Studio 子命令。 */
const scriptRequirements = [
  {
    name: "eval:finance-golden:mine",
    command: "mine"
  },
  {
    name: "eval:finance-golden:validate",
    command: "validate"
  },
  {
    name: "eval:finance-golden:promote",
    command: "promote"
  },
  {
    name: "eval:finance-golden:generate",
    command: "generate"
  },
  {
    name: "eval:finance-golden:annotate",
    command: "serve"
  }
] as const;

/**
 * 判断兼容脚本是否经唯一根入口分发并携带预期子命令。
 *
 * @param script 根 scripts 定义。
 * @param command 预期子命令。
 * @returns 符合约定时为 true。
 */
function delegatesToGoldenStudio(script: string, command: string): boolean {
  const tokens = script.trim().split(/\s+/);
  const goldenIndex = tokens.indexOf("golden-studio");
  if (goldenIndex < 0) return false;
  if (tokens[goldenIndex + 1] !== command) return false;
  const runner = tokens.slice(0, goldenIndex);
  return (
    runner.length === 0 ||
    runner[0] === "pnpm" ||
    runner[0] === "golden-studio" ||
    runner[0] === "node"
  );
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
