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
  validate: "正在校验",
  promote: "正在发布草稿",
  generate: "正在生成评测集",
  mine: "正在挖掘候选"
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
        title: `${action.label}？`,
        description: "服务端将校验当前的作者数据。",
        confirmLabel: "开始校验"
      };
    case "promote":
      return {
        title: `${action.label}？`,
        description:
          "已审核的草稿将追加到作者集。写入前会创建快照。",
        confirmLabel: "确认发布"
      };
    case "generate":
      return {
        title: `${action.label}？`,
        description:
          "将使用当前作者集替换已生成的评测产物。",
        confirmLabel: "确认生成"
      };
    case "mine":
      return {
        title: `${action.label}？`,
        description:
          "服务端将根据提供的语料引用创建候选草稿。",
        confirmLabel: "挖掘候选"
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
    if (validation.ok === false) return "校验完成，但存在错误。";
    return "校验通过。";
  }
  if (name === "promote") {
    if (data.ok === false) return "发布在修改作者集前中止。";
    return `已发布 ${numberValue(data.promotedCount)} 份草稿。`;
  }
  if (name === "generate") {
    if (data.ok === false) return "生成在写入评测产物前中止。";
    const count = numberValue(data.caseCount);
    return `已生成 ${count} 条评测用例。`;
  }
  if (data.ok === false) return "挖掘完成，但跳过了部分候选。";
  return `已挖掘 ${numberValue(data.draftedCount)} 份候选草稿。`;
}

/**
 * 把未知异常投影为不会吞掉 server 错误的文本。
 *
 * @param error 捕获值。
 * @returns 可展示错误。
 */
export function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知的服务端动作错误。";
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
