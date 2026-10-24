/**
 * provider 错误提示：从 harness 拆出，打破 harness ↔ web-entry 的运行时循环依赖
 * （单一形态下 TUI 与 Web 托管入口都需要打印「未配置真实 provider」的同一份文案）。
 */

/**
 * 打印「未配置真实 provider」的中文错误，并指明需在 .env 配置环境变量（项目已移除 mock）。
 *
 * @param modelFlag 用户指定的 model（若有），用于给出更精确的提示。
 */
export function printProviderError(modelFlag?: string): void {
  const lines: string[] = [];
  if (modelFlag) {
    lines.push(`指定的模型 "${modelFlag}" 未配置有效的真实 provider。`);
  } else {
    lines.push("未检测到任何已配置的真实模型 provider。");
  }
  lines.push("");
  lines.push("本项目已彻底移除 mock，必须提供真实凭据才能运行。请在 .env 中配置以下环境变量之一：");
  lines.push("  AIAGENT_LLM_API_KEY_DEEPSEEK 与 AIAGENT_LLM_MODEL_DEEPSEEK");
  lines.push("  AIAGENT_LLM_API_KEY_OPENROUTER 与 AIAGENT_LLM_MODEL_OPENROUTER");
  lines.push("  AIAGENT_LLM_API_KEY_BRIDGE_AI、AIAGENT_LLM_BASE_URL_BRIDGE_AI 与 AIAGENT_LLM_MODEL_BRIDGE_AI");
  lines.push("");
  lines.push("配置后重新运行：ohna \"你的问题\"");
  process.stderr.write(lines.join("\n") + "\n");
}
