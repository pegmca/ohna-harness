import { GoldenStudioError } from "../core/errors.js";
import type { ValidationReport } from "../core/schema.js";
import { WorkspaceError } from "../core/workspace.js";
import type { CliCommand } from "./args.js";
import { CliError } from "./args.js";
import type { DoctorReport } from "./doctor.js";

/** 成功 JSON 信封。 */
interface SuccessEnvelope {
  ok: true;
  command: CliCommand;
  result: unknown;
  validation?: ValidationReport;
}

/** 失败 JSON 信封。 */
interface FailureEnvelope {
  ok: false;
  command: CliCommand | null;
  error: string;
  message: string;
  details: Record<string, unknown>;
  validation?: ValidationReport;
  result?: unknown;
}

/** 命令结果投影。 */
export interface CommandOutcome {
  ok: boolean;
  payload: unknown;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
  validation?: ValidationReport;
}

/**
 * 将 core 返回值投影为统一的成功或失败结果。
 *
 * @param command 当前命令。
 * @param result core 返回值。
 * @returns 可格式化的结果。
 */
export function projectCommandResult(
  command: CliCommand,
  result: unknown
): CommandOutcome {
  const validation = command === "validate" ? reportFromValidate(result) : undefined;
  if (validation) {
    return validation.ok
      ? { ok: true, payload: result, validation }
      : {
          ok: false,
          payload: result,
          error: "validation_failed",
          message: "Validation completed with one or more errors.",
          validation
        };
  }
  if (isRecord(result) && result.ok === false) {
    const error = failureCode(command);
    const outcome: CommandOutcome = {
      ok: false,
      payload: result,
      error,
      message: failureMessage(command, result)
    };
    const validation = result.validation;
    if (isValidationReport(validation)) outcome.validation = validation;
    return outcome;
  }
  if (isRecord(result) && result.ok === true && command !== "doctor") {
    return { ok: true, payload: result };
  }
  return { ok: true, payload: result };
}

/**
 * 输出成功结果。
 *
 * @param command 当前命令。
 * @param outcome 投影结果。
 * @param json 是否启用 JSON。
 */
export function printSuccess(
  command: CliCommand,
  outcome: CommandOutcome,
  json: boolean
): void {
  if (json) {
    const envelope: SuccessEnvelope = {
      ok: true,
      command,
      result: outcome.payload,
      ...(outcome.validation ? { validation: outcome.validation } : {})
    };
    writeStdout(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (command === "doctor" && isDoctorReport(outcome.payload)) {
    writeStdout(
      `${outcome.payload.checks
        .map(
          (check) =>
            `${check.ok ? "ok" : "failed"} ${check.name}: ${check.message}`
        )
        .join("\n")}\n`
    );
    return;
  }
  writeStdout(`${summary(command, outcome.payload)}\n`);
}

/**
 * 输出失败结果。
 *
 * @param command 当前命令。
 * @param outcome 投影结果。
 * @param json 是否启用 JSON。
 */
export function printFailure(
  command: CliCommand | null,
  outcome: Pick<CommandOutcome, "error" | "message" | "details" | "validation"> & {
    payload?: unknown;
  },
  json: boolean
): void {
  const error = outcome.error ?? "command_failed";
  const message = outcome.message ?? error;
  if (json) {
    const envelope: FailureEnvelope = {
      ok: false,
      command,
      error,
      message,
      details: outcome.details ?? {}
    };
    if (outcome.validation) envelope.validation = outcome.validation;
    if (command === "doctor" && isDoctorReport(outcome.payload)) {
      envelope.result = outcome.payload;
    } else if (command !== null && command !== "validate") {
      envelope.result = outcome.payload;
    }
    writeStdout(`${JSON.stringify(envelope)}\n`);
    return;
  }
  writeStderr(`${error}: ${message}\n`);
}

/**
 * 将异常映射为稳定 CLI 失败字段。
 *
 * @param error 捕获值。
 * @returns 稳定错误码、说明与详情。
 */
export function projectError(error: unknown): {
  error: string;
  message: string;
  details: Record<string, unknown>;
} {
  if (error instanceof CliError) {
    return {
      error: error.code,
      message: error.message,
      details: error.details
    };
  }
  if (error instanceof WorkspaceError || error instanceof GoldenStudioError) {
    return {
      error: error.code,
      message: error.message,
      details: error instanceof GoldenStudioError ? error.details : {}
    };
  }
  return {
    error: "internal_error",
    message: error instanceof Error ? error.message : String(error),
    details: {}
  };
}

/**
 * 只从 validate 结果中提取 ValidationReport。
 *
 * @param result validate core 返回值。
 * @returns 校验报告或 undefined。
 */
function reportFromValidate(result: unknown): ValidationReport | undefined {
  if (isRecord(result) && isValidationReport(result.validation)) {
    return result.validation;
  }
  return undefined;
}

/**
 * 为显式 ok:false 工作流选择稳定错误码。
 *
 * @param command 当前命令。
 * @returns 稳定错误码。
 */
function failureCode(command: CliCommand): string {
  if (command === "mine") return "mine_incomplete";
  if (command === "promote") return "promotion_failed";
  if (command === "generate") return "generation_failed";
  if (command === "doctor") return "doctor_failed";
  return "command_failed";
}

/**
 * 为失败工作流生成不含偶然字段的人类说明。
 *
 * @param command 当前命令。
 * @param result core 失败报告。
 * @returns 说明。
 */
function failureMessage(
  command: CliCommand,
  result: Record<string, unknown>
): string {
  if (typeof result.message === "string") return result.message;
  if (command === "mine") {
    return `${Number(result.skippedCount ?? 0)} candidate(s) could not be mined.`;
  }
  if (command === "promote") return "Promotion did not complete.";
  if (command === "generate") return "Evaluation dataset was not generated.";
  return `${command} did not complete.`;
}

/**
 * 为人类模式生成精简摘要，不展开 core 的完整数据集或草稿正文。
 *
 * @param command 当前命令。
 * @param result 命令结果。
 * @returns 单行或少量行的摘要。
 */
function summary(command: CliCommand, result: unknown): string {
  if (!isRecord(result)) return `ok ${command}`;
  if (command === "mine") {
    return `mined ${Number(result.draftedCount ?? 0)} draft(s) in ${String(result.batch ?? "unknown")}.`;
  }
  if (command === "validate") {
    const validation = reportFromValidate(result);
    return validation
      ? `validated with ${validation.errors.length} error(s) and ${validation.warnings.length} warning(s).`
      : "validated.";
  }
  if (command === "promote") {
    return `promoted ${Number(result.promotedCount ?? 0)} draft(s).`;
  }
  if (command === "generate") {
    return `generated ${Number(result.caseCount ?? 0)} evaluation case(s).`;
  }
  return `ok ${command}`;
}

/**
 * 判断 doctor 返回值。
 *
 * @param value 待判断值。
 * @returns 是 doctor 报告时为 true。
 */
function isDoctorReport(value: unknown): value is DoctorReport {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.checks)
  );
}

/**
 * 判断校验报告最小形状。
 *
 * @param value 待判断值。
 * @returns 是 ValidationReport 时为 true。
 */
function isValidationReport(value: unknown): value is ValidationReport {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.errors) &&
    Array.isArray(value.warnings) &&
    Array.isArray(value.keywordResults)
  );
}

/**
 * 判断普通对象。
 *
 * @param value 待判断值。
 * @returns 非数组对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 写入标准输出。
 *
 * @param text 输出文本。
 */
function writeStdout(text: string): void {
  process.stdout.write(text);
}

/**
 * 写入标准错误。
 *
 * @param text 输出文本。
 */
function writeStderr(text: string): void {
  process.stderr.write(text);
}
