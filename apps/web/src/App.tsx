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

      <section className="status-grid" aria-label="Workspace boundaries">
        <article>
          <span>Agent</span>
          <strong>packages/agent</strong>
          <p>Core agent orchestration boundary for future loop work.</p>
        </article>
        <article>
          <span>Tools</span>
          <strong>packages/tools</strong>
          <p>Tool contracts and integrations stay outside the web shell.</p>
        </article>
        <article>
          <span>Trace</span>
          <strong>packages/trace</strong>
          <p>Runtime observability data will be exposed through app APIs.</p>
        </article>
      </section>
    </main>
  );
}
