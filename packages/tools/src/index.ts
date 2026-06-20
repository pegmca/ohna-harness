export interface ToolRegistrySummary {
  packageName: string;
  availableTools: number;
}

export function getToolRegistrySummary(): ToolRegistrySummary {
  return {
    packageName: "@aiagent/tools",
    availableTools: 0
  };
}
