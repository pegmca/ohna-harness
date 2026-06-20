import { createAgentStatus } from "@aiagent/agent";
import { getToolRegistrySummary } from "@aiagent/tools";
import { createTraceSummary } from "@aiagent/trace";

const agentStatus = createAgentStatus();
const toolRegistry = getToolRegistrySummary();
const traceSummary = createTraceSummary();

export function App() {
  return (
    <main className="app-shell">
      <section className="overview">
        <p className="eyebrow">Week 1 Foundation</p>
        <h1>AI Agent Workspace</h1>
        <p className="summary">
          Monorepo foundation for the immersive financial research agent.
        </p>
      </section>

      <section className="status-grid" aria-label="Package status">
        <article>
          <span>Agent</span>
          <strong>{agentStatus.name}</strong>
          <p>{agentStatus.description}</p>
        </article>
        <article>
          <span>Tools</span>
          <strong>{toolRegistry.packageName}</strong>
          <p>{toolRegistry.availableTools} tools registered</p>
        </article>
        <article>
          <span>Trace</span>
          <strong>{traceSummary.packageName}</strong>
          <p>{traceSummary.eventCount} events recorded</p>
        </article>
      </section>
    </main>
  );
}
