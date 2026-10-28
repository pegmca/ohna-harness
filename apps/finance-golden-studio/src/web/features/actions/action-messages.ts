import type {
  GoldenStudioAction,
  GoldenStudioActionResult
} from "../../shared/api/types.ts";

/** 确认框中的动作名称与风险说明。 */
export interface ActionConfirmationCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/** 动作运行中的固定标签，保证按钮宽度不随文案变化。 */
export const ACTION_RUNNING_LABELS: Record<GoldenStudioAction["action"], string> = {
  validate: "Running validation",
  promote: "Promoting drafts",
  generate: "Generating eval set",
  mine: "Mining candidates"
};

/**
 * 为生成或变更数据的动作提供确认文案。
 *
 * @param action UI 动作配置。
 * @returns 确认标题、说明与确认按钮文案。
 */
export function actionConfirmation(
  action: GoldenStudioAction
): ActionConfirmationCopy {
  switch (action.action) {
    case "validate":
      return {
        title: `${action.label}?`,
        description: "The server will validate current authored data.",
        confirmLabel: "Run validation"
      };
    case "promote":
      return {
        title: `${action.label}?`,
        description:
          "Approved drafts will be appended to the authored golden set. A snapshot is taken before writing.",
        confirmLabel: "Confirm promotion"
      };
    case "generate":
      return {
        title: `${action.label}?`,
        description:
          "The generated evaluation artifact will be replaced using the current authored golden set.",
        confirmLabel: "Confirm generation"
      };
    case "mine":
      return {
        title: `${action.label}?`,
        description:
          "The server will create candidate drafts from the supplied corpus references.",
        confirmLabel: "Mine candidates"
      };
  }
}

/**
 * 从 server 响应生成简短、可证明的结果说明。
 *
 * @param name 已完成的动作。
 * @param result server 原样返回的动作结果。
 * @returns 不含推测数据的成功文案。
 */
export function actionSuccessMessage(
  name: GoldenStudioAction["action"],
  result: GoldenStudioActionResult
): string {
  const data = result.result;
  if (name === "validate") {
    const validation = asRecord(data.validation) ?? data;
    if (validation.ok === false) return "Validation completed with errors.";
    return "Validation passed.";
  }
  if (name === "promote") {
    if (data.ok === false) return "Promotion stopped before changing the authored set.";
    return `Promoted ${numberValue(data.promotedCount)} drafts.`;
  }
  if (name === "generate") {
    if (data.ok === false) return "Generation stopped before writing the eval artifact.";
    const count = numberValue(data.caseCount);
    return `Generated ${count} evaluation ${count === 1 ? "case" : "cases"}.`;
  }
  if (data.ok === false) return "Mining completed with skipped candidates.";
  return `Mined ${numberValue(data.draftedCount)} candidate drafts.`;
}

/**
 * 把未知异常投影为不会吞掉 server 错误的文本。
 *
 * @param error 捕获值。
 * @returns 可展示错误。
 */
export function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown server action failure.";
}

/**
 * 读取非负整数，损坏结果按 0 处理。
 *
 * @param value server 字段。
 * @returns 可直接展示的整数。
 */
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/**
 * 判断普通对象。
 *
 * @param value server 字段。
 * @returns 普通对象时为 true。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
