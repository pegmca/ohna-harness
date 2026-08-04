import type {
  ApiResult,
  DataSourceChunksResponseDto,
  DataSourceDocumentDto,
  DataSourceDocumentsResponseDto,
  DataSourceIngestResponseDto,
  ProductArchitectureDto,
  ProductEvalReportDto,
  RagAnswerResponseDto,
  RagChunkDto,
  RagSearchResponseDto,
  RetrievalResultDto
} from "@aiagent/types";
import {
  Braces,
  Database,
  FileText,
  Loader2,
  Menu,
  Plus,
  Quote,
  Search,
  Send
} from "lucide-react";
import { useEffect, useState } from "react";
import { formatApiError, parseApiResult } from "./format";
import { ErrorBlock, StatusBadge } from "./run-details";
import type { WorkspaceView } from "./types";

export const demoDataSourceContent = `# 资产质量
公司不良率保持稳定，拨备覆盖率维持在安全水平。

# 盈利能力
公司净利润同比增长，ROE 保持在较高水平。

# 现金流
经营性现金流改善，但资本开支增加带来短期压力。`;

/** 展示 Workflow、Citation、Eval 与 Architecture 产品视图；report 工作流数据已随 pi 化改造移除，阶段 5 回迁。 */
export function ProductWorkspace(props: { onMenuClick: () => void; view: Exclude<WorkspaceView, "chat" | "scheduled-tasks" | "data-sources" | "settings"> }) {
  const [evalReport, setEvalReport] = useState<ProductEvalReportDto>();
  const [architecture, setArchitecture] = useState<ProductArchitectureDto>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    if (props.view === "eval") void fetchProductEval().then((result) => active && (result.ok ? setEvalReport(result.data) : setError(formatApiError(result.error))));
    if (props.view === "architecture") void fetchProductArchitecture().then((result) => active && (result.ok ? setArchitecture(result.data) : setError(formatApiError(result.error))));
    return () => { active = false; };
  }, [props.view]);

  const title = props.view === "workflow" ? "Report Workflow" : props.view === "citations" ? "Citation Checker" : props.view === "eval" ? "Eval Report" : "Architecture";
  return (
    <section className="data-sources-main product-main" aria-label={title}>
      <header className="data-header"><div className="header-title-group">
        <button className="icon-button mobile-only" onClick={props.onMenuClick} type="button" aria-label="打开导航"><Menu className="icon-size" /></button>
        <div><p className="md-label">Immersive Product</p><h2 className="chat-title">{title}</h2></div>
      </div>{props.view === "eval" && evalReport ? <StatusBadge tone="info">DEMO DATA · {evalReport.datasetVersion}</StatusBadge> : null}</header>
      <div className="product-content">
        {error ? <ErrorBlock error={{ code: "internal_error", message: error }} /> : null}
        {props.view === "workflow" ? <ProductEmpty text="报告工作流能力已随 pi 化改造暂时下线，将在后续阶段恢复；届时这里会展示真实 run 的节点输入、输出、耗时和错误。" /> : null}
        {props.view === "citations" ? <ProductEmpty text="报告引用校验已随 pi 化改造暂时下线；恢复后可从关键结论回溯 document、chunk 和 source。" /> : null}
        {props.view === "eval" ? evalReport ? <EvalReportView report={evalReport} /> : <LoadingBlock /> : null}
        {props.view === "architecture" ? architecture ? <ArchitectureView value={architecture} /> : <LoadingBlock /> : null}
      </div>
    </section>
  );
}

/** @param props 空状态说明。 @returns 可解释空状态。 */
export function ProductEmpty(props: { text: string }) { return <div className="product-empty"><FileText /><h3>暂无当前运行数据</h3><p>{props.text}</p></div>; }
/** @returns 产品视图加载状态。 */
export function LoadingBlock() { return <div className="product-empty"><Loader2 className="spin" /><p>正在读取 API DTO…</p></div>; }

/** 展示版本化 eval 当前值、baseline 和至少三个失败案例。 */
export function EvalReportView(props: { report: ProductEvalReportDto }) {
  const primary = ["citationCoverage", "financialAccuracy", "sourceGroundedness", "successRate"];
  return <div className="product-stack"><div className="metric-grid">{primary.map((key) => <article className="metric-card" key={key}><span>{key}</span><strong>{formatMetric(props.report.metrics[key])}</strong><small>baseline {formatMetric(props.report.baseline[key])}</small></article>)}</div>
    <section className="data-panel"><div className="panel-heading"><h3>Failure cases</h3><StatusBadge tone="danger">{props.report.failures.length}</StatusBadge></div><div className="data-list">{props.report.failures.map((failure) => <article className="data-row" key={failure.caseId}><strong>{failure.caseId} · {failure.query}</strong><span>{failure.rootCause}</span><small>{failure.improvement}</small><small>{failure.requestId} / {failure.traceId}</small></article>)}</div></section></div>;
}

/** 使用节点与边列表展示真实包责任和依赖方向，移动端无需横向图布。 */
export function ArchitectureView(props: { value: ProductArchitectureDto }) {
  return <div className="architecture-grid"><section className="data-panel"><div className="panel-heading"><h3>Package boundaries</h3></div>{props.value.nodes.map((node) => <article className="architecture-node" key={node.id}><strong>{node.label}</strong><span>{node.responsibility}</span></article>)}</section>
    <section className="data-panel"><div className="panel-heading"><h3>Dependency flow</h3></div>{props.value.edges.map((edge, index) => <article className="architecture-edge" key={`${edge.from}-${edge.to}-${index}`}><code>{edge.from}</code><span>→ {edge.label} →</span><code>{edge.to}</code></article>)}</section></div>;
}

/** @param value 指标值。 @returns 评分显示；延迟保留毫秒。 */
export function formatMetric(value: number | undefined): string { return value === undefined ? "—" : value <= 1 ? `${(value * 100).toFixed(1)}%` : `${value.toFixed(1)} ms`; }

/**
 * 定时任务占位工作区；后续将在这里拓展定时创建研究任务、查看执行历史等能力。
 *
 * @param props 移动端打开侧栏回调。
 * @returns 占位页面。
 */
export function ScheduledTasksWorkspace(props: { onMenuClick: () => void }) {
  return (
    <section className="data-sources-main product-main" aria-label="定时任务">
      <header className="data-header"><div className="header-title-group">
        <button className="icon-button mobile-only" onClick={props.onMenuClick} type="button" aria-label="打开导航"><Menu className="icon-size" /></button>
        <div><p className="md-label">Immersive Product</p><h2 className="chat-title">定时任务</h2></div>
      </div></header>
      <div className="product-content">
        <ProductEmpty text="定时任务功能即将上线：届时可以按周期自动发起研究、生成研报并推送结果。" />
      </div>
    </section>
  );
}

/**
 * Data Sources 页面通过 HTTP API 演示 ingestion、chunk、retrieval 和 citation answer 数据流。
 *
 * @param props 组件属性。
 * @returns Data Sources 产品功能页。
 */
export function DataSourcesWorkspace(props: { onMenuClick: () => void }) {
  const [source, setSource] = useState("demo");
  const [fileName, setFileName] = useState("annual-report.md");
  const [content, setContent] = useState(demoDataSourceContent);
  const [query, setQuery] = useState("资产质量");
  const [question, setQuestion] = useState("公司资产质量如何？");
  const [documents, setDocuments] = useState<DataSourceDocumentDto[]>([]);
  const [chunks, setChunks] = useState<RagChunkDto[]>([]);
  const [searchResults, setSearchResults] = useState<RetrievalResultDto[]>([]);
  const [answer, setAnswer] = useState<RagAnswerResponseDto | undefined>();
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | undefined>();

  /**
   * 刷新 documents 和 chunks，保证页面展示服务端内存 runtime 当前状态。
   *
   * @returns 请求完成 Promise。
   */
  async function refreshDataSources(): Promise<void> {
    const [documentsResult, chunksResult] = await Promise.all([fetchDataSourceDocuments(), fetchDataSourceChunks()]);

    if (!documentsResult.ok) {
      setError(formatApiError(documentsResult.error));
      return;
    }

    if (!chunksResult.ok) {
      setError(formatApiError(chunksResult.error));
      return;
    }

    setDocuments(documentsResult.data.documents);
    setChunks(chunksResult.data.chunks);
  }

  /**
   * 提交 Markdown/TXT 文档到 ingestion API，并刷新列表。
   *
   * @returns 请求完成 Promise。
   */
  async function handleIngest(): Promise<void> {
    setStatus("ingesting");
    setError(undefined);

    const result = await ingestDataSource({
      source,
      fileName,
      contentType: fileName.endsWith(".txt") ? "text/plain" : "text/markdown",
      content
    });

    if (!result.ok) {
      setError(formatApiError(result.error));
      setStatus("failed");
      return;
    }

    // ingest 成功后重新拉取分页列表，文档行展示服务端持久化的版本与状态。
    await refreshDataSources();
    setStatus(`indexed ${result.data.indexedChunkCount} chunks`);
  }

  /**
   * 调用 RAG search API 并展示检索结果。
   *
   * @returns 请求完成 Promise。
   */
  async function handleSearch(): Promise<void> {
    setStatus("searching");
    setError(undefined);

    const result = await searchRag(query);

    if (!result.ok) {
      setError(formatApiError(result.error));
      setStatus("failed");
      return;
    }

    setSearchResults(result.data.results);
    setStatus(`${result.data.results.length} results`);
  }

  /**
   * 调用 RAG answer API，展示 answer 和 citations。
   *
   * @returns 请求完成 Promise。
   */
  async function handleAnswer(): Promise<void> {
    setStatus("answering");
    setError(undefined);

    const result = await answerRag(question);

    if (!result.ok) {
      setError(formatApiError(result.error));
      setStatus("failed");
      return;
    }

    setAnswer(result.data);
    setStatus(`${result.data.answer.citations.length} citations`);
  }

  return (
    <section className="data-sources-main" aria-label="Data Sources">
      <header className="data-header">
        <div className="header-title-group">
          <button className="icon-button mobile-only" onClick={props.onMenuClick} type="button" aria-label="打开会话列表">
            <Menu className="icon-size" />
          </button>
          <div className="min-w-0">
            <p className="md-label">RAG Knowledge Base</p>
            <h2 className="chat-title">Data Sources</h2>
          </div>
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={refreshDataSources} type="button">
            <Database className="icon-size" />
            <span>Refresh</span>
          </button>
          <StatusBadge tone={status === "failed" ? "danger" : status === "idle" ? "neutral" : "info"}>{status}</StatusBadge>
        </div>
      </header>

      <div className="data-sources-grid">
        <section className="data-panel ingest-panel">
          <div className="panel-heading">
            <h3>
              <FileText className="icon-size" />
              Ingest
            </h3>
            <button className="secondary-button" onClick={handleIngest} type="button">
              <Plus className="icon-size" />
              <span>Index</span>
            </button>
          </div>
          <div className="field-grid">
            <label>
              <span>Source</span>
              <input value={source} onChange={(event) => setSource(event.target.value)} />
            </label>
            <label>
              <span>File</span>
              <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
            </label>
          </div>
          <textarea className="data-textarea" value={content} onChange={(event) => setContent(event.target.value)} />
          {error ? <ErrorBlock error={{ code: "internal_error", message: error }} /> : null}
        </section>

        <section className="data-panel retrieval-panel">
          <div className="panel-heading">
            <h3>
              <Database className="icon-size" />
              Documents
            </h3>
            <StatusBadge tone="neutral">{documents.length}</StatusBadge>
          </div>
          <div className="data-list">
            {documents.length === 0 ? <p className="muted-row">暂无文档。先 ingest Markdown/TXT。</p> : null}
            {documents.map((document) => (
              <article className="data-row" key={document.documentId}>
                <strong>{document.title}</strong>
                <span>v{document.latestVersion} · {document.latestStatus} · {document.scope}</span>
                <small>{document.sourceUri}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="data-panel chunks-panel">
          <div className="panel-heading">
            <h3>
              <Braces className="icon-size" />
              Chunks
            </h3>
            <StatusBadge tone="neutral">{chunks.length}</StatusBadge>
          </div>
          <div className="data-list">
            {chunks.length === 0 ? <p className="muted-row">暂无 chunks。</p> : null}
            {chunks.map((chunk) => (
              <article className="data-row" key={chunk.chunkId}>
                <strong>{chunk.heading ?? "未命名章节"}</strong>
                <span>{chunk.text}</span>
                <small>
                  {chunk.documentId} / chunk {chunk.chunkIndex}
                </small>
              </article>
            ))}
          </div>
        </section>

        <section className="data-panel">
          <div className="panel-heading">
            <h3>
              <Search className="icon-size" />
              Retrieval
            </h3>
            <button className="secondary-button" onClick={handleSearch} type="button">
              <Search className="icon-size" />
              <span>Search</span>
            </button>
          </div>
          <input className="data-input" value={query} onChange={(event) => setQuery(event.target.value)} />
          <RetrievalResults results={searchResults} />
        </section>

        <section className="data-panel answer-panel">
          <div className="panel-heading">
            <h3>
              <Quote className="icon-size" />
              Citation Answer
            </h3>
            <button className="secondary-button" onClick={handleAnswer} type="button">
              <Send className="icon-size" />
              <span>Answer</span>
            </button>
          </div>
          <input className="data-input" value={question} onChange={(event) => setQuestion(event.target.value)} />
          {answer ? (
            <div className="answer-output">
              <p>{answer.answer.answer}</p>
              <CitationList citations={answer.answer.citations} />
              <RetrievalResults results={answer.answer.retrievalResults} compact />
            </div>
          ) : (
            <p className="muted-row">暂无 answer。可以先提问一个资料中不存在的问题验证 unknown policy。</p>
          )}
        </section>
      </div>
    </section>
  );
}

/**
 * 展示 retrieval result 列表，默认包含 score 和 citation 元数据。
 *
 * @param props 组件属性。
 * @returns retrieval results。
 */
export function RetrievalResults(props: { compact?: boolean; results: RetrievalResultDto[] }) {
  return (
    <div className={`retrieval-results ${props.compact ? "is-compact" : ""}`}>
      {props.results.length === 0 ? <p className="muted-row">暂无检索结果。</p> : null}
      {props.results.map((result) => (
        <article className="data-row" key={`${result.chunkId}-${result.rank ?? 0}`}>
          <strong>
            #{result.rank ?? "-"} score {result.score.toFixed(3)}
          </strong>
          <span>{result.text}</span>
          <small>
            {result.citation.source} / {result.citation.heading ?? "no heading"} / chunk{" "}
            {result.citation.chunkIndex}
          </small>
        </article>
      ))}
    </div>
  );
}

/**
 * 展示 answer citations，强调每条引用可以追溯到 source、heading 和 chunkIndex。
 *
 * @param props 组件属性。
 * @returns citation 列表。
 */
export function CitationList(props: { citations: RagAnswerResponseDto["answer"]["citations"] }) {
  return (
    <div className="citation-list">
      {props.citations.length === 0 ? <p className="muted-row">当前 answer 没有可用 citation。</p> : null}
      {props.citations.map((citation, index) => (
        <article className="citation-row" key={`${citation.chunkId}-${index}`}>
          <strong>[{index + 1}]</strong>
          <div>
            <span>{citation.quote}</span>
            <small>
              {citation.source} / {citation.heading ?? "no heading"} / chunk {citation.chunkIndex}
            </small>
          </div>
        </article>
      ))}
    </div>
  );
}

/** @returns 版本化 eval 展示 DTO。 */
async function fetchProductEval(): Promise<ApiResult<ProductEvalReportDto>> { return parseApiResult(await fetch("/api/product/eval-report")); }
/** @returns 当前 package 架构展示 DTO。 */
async function fetchProductArchitecture(): Promise<ApiResult<ProductArchitectureDto>> { return parseApiResult(await fetch("/api/product/architecture")); }

/**
 * 调用 Data Sources ingestion API。
 *
 * @param request ingestion 请求。
 * @returns 结构化 ingestion 结果。
 */
async function ingestDataSource(request: {
  source: string;
  fileName: string;
  contentType?: string;
  content: string;
}): Promise<ApiResult<DataSourceIngestResponseDto>> {
  const response = await fetch("/api/data-sources/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(request)
  });

  return parseApiResult(response);
}

/**
 * 获取当前 API 进程内的文档列表。
 *
 * @returns 文档列表 API result。
 */
async function fetchDataSourceDocuments(): Promise<ApiResult<DataSourceDocumentsResponseDto>> {
  return parseApiResult(await fetch("/api/data-sources/documents"));
}

/**
 * 获取当前 API 进程内的 chunk 列表。
 *
 * @returns chunk 列表 API result。
 */
async function fetchDataSourceChunks(): Promise<ApiResult<DataSourceChunksResponseDto>> {
  return parseApiResult(await fetch("/api/data-sources/chunks"));
}

/**
 * 调用 RAG search API。
 *
 * @param query 检索问题。
 * @returns search API result。
 */
async function searchRag(query: string): Promise<ApiResult<RagSearchResponseDto>> {
  const response = await fetch("/api/rag/search", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query,
      topK: 5
    })
  });

  return parseApiResult(response);
}

/**
 * 调用 RAG answer API。
 *
 * @param question 用户问题。
 * @returns answer API result。
 */
async function answerRag(question: string): Promise<ApiResult<RagAnswerResponseDto>> {
  const response = await fetch("/api/rag/answer", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      question,
      topK: 5
    })
  });

  return parseApiResult(response);
}
