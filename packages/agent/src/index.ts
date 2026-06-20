export interface AgentStatus {
  name: string;
  description: string;
  ready: boolean;
}

export function createAgentStatus(): AgentStatus {
  return {
    name: "@aiagent/agent",
    description: "Agent package skeleton is available for future loop work.",
    ready: true
  };
}
