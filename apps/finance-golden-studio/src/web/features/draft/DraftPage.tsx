import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, ChevronLeft, Save, ShieldCheck } from "lucide-react";
import type {
  DraftValidationSnapshot,
  GoldenDraft,
  PdfEvidenceDocument,
  ValidationIssue,
  ValidationReport
} from "../../../core/types.ts";
import { useApiClient } from "../../app/context.tsx";
import { createKeywordValidationSummary } from "../../../core/keyword-report.ts";
import { ApiError } from "../../shared/api/client.ts";
import { BasicFields } from "./BasicFields.tsx";
import { EvidencePane } from "./EvidencePane.tsx";
import {
  findKeywordReachability,
  listDraftSources,
  resolveDraftSourcePath,
  type DraftSourceOption
} from "./evidencing.ts";
import { FormEditor } from "./FormEditor.tsx";
import { KeywordEditor } from "./KeywordEditor.tsx";
import { TableEditor } from "./TableEditor.tsx";
import { ValidationPanel } from "./ValidationPanel.tsx";

/** 草稿页加载状态。 */
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; draft: GoldenDraft };

/** 当前提交中的动作。 */
type PendingAction = "save" | "validate" | "approve" | undefined;

/**
 * 证据优先的草稿编辑器页面。
 *
 * @returns 加载、错误或三栏编辑工作区。
 */
export function DraftPage() {
  const client = useApiClient();
  const { batch = "", id = "" } = useParams();
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<GoldenDraft | undefined>();
  const [documents, setDocuments] = useState<PdfEvidenceDocument[]>([]);
  const [report, setReport] = useState<ValidationReport | undefined>();
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<PendingAction>();
  const [statusMessage, setStatusMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [evidenceError, setEvidenceError] = useState("");
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const sources = useMemo(
    () => (draft ? listDraftSources(draft) : []),
    [draft]
  );
  const sourceSignature = sources.map((source) => source.filePath).join("\u0000");

  useEffect(() => {
    const controller = new AbortController();
    setLoadState({ status: "loading" });
    client
      .readDraft(batch, id, { signal: controller.signal })
      .then((loaded) => {
        setDraft(loaded);
        setReport(fromSnapshot(loaded._draft.validation));
        setDirty(false);
        setLoadState({ status: "ready", draft: loaded });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({
          status: "error",
          message: errorMessage(error)
        });
      });
    return () => controller.abort();
  }, [batch, client, id]);

  useEffect(() => {
    if (sources.length === 0) {
      setDocuments([]);
      setEvidenceError("");
      return;
    }
    const controller = new AbortController();
    setEvidenceLoading(true);
    Promise.all(
      sources.map((source) =>
        client.readEvidence(source.filePath, { signal: controller.signal })
      )
    )
      .then((loaded) => {
        setDocuments(loaded);
        setEvidenceError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDocuments([]);
        setEvidenceError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setEvidenceLoading(false);
      });
    return () => controller.abort();
  }, [client, sourceSignature]);

  const reachability = useMemo(
    () => findKeywordReachability(documents, draft?.expected_keywords ?? []),
    [documents, draft?.expected_keywords]
  );
  const errors = report?.errors ?? [];
  const approvalBlocked =
    dirty ||
    (report !== undefined && (!report.ok || errors.length > 0)) ||
    pending !== undefined;

  if (loadState.status === "loading") {
    return (
      <section className="draft-page">
        <p className="empty-state">正在加载草稿</p>
      </section>
    );
  }
  if (loadState.status === "error") {
    return (
      <section className="draft-page">
        <Link className="back-link" to={`/batch/${encodeURIComponent(batch)}`}>
          <ChevronLeft aria-hidden="true" size={15} />
          返回草稿列表
        </Link>
        <div className="error-state" role="alert">
          <p className="error-title">无法加载草稿</p>
          <p className="error-message">{loadState.message}</p>
        </div>
      </section>
    );
  }
  if (!draft) return null;

  const updateDraft = (next: GoldenDraft): void => {
    setDraft(next);
    setDirty(true);
    setActionError("");
    setStatusMessage("");
  };

  const persist = async (
    candidate: GoldenDraft,
    action: Exclude<PendingAction, undefined>
  ): Promise<GoldenDraft | undefined> => {
    if (!client.saveDraft) {
      setActionError("注入的客户端无法保存草稿。");
      return undefined;
    }
    setPending(action);
    setActionError("");
    setStatusMessage("");
    try {
      const saved = await client.saveDraft(batch, id, candidate);
      setDraft(saved);
      setDirty(false);
      return saved;
    } catch (error) {
      setActionError(errorMessage(error));
      return undefined;
    } finally {
      setPending(undefined);
    }
  };

  const validate = async (): Promise<ValidationReport | undefined> => {
    setPending("validate");
    setActionError("");
    try {
      const result = await client.validateDraft(batch, id);
      const nextReport = asReport(result);
      setReport(nextReport);
      setStatusMessage(
        nextReport.ok ? "校验通过。" : "校验需要关注。"
      );
      return nextReport;
    } catch (error) {
      setActionError(errorMessage(error));
      return undefined;
    } finally {
      setPending(undefined);
    }
  };

  const save = async (): Promise<void> => {
    const saved = await persist(draft, "save");
    if (saved) setStatusMessage("草稿已保存。");
  };

  const saveAndValidate = async (): Promise<void> => {
    const saved = await persist(draft, "validate");
    if (!saved) return;
    const nextReport = await validate();
    if (nextReport) {
      const verified: GoldenDraft = {
        ...saved,
        _draft: {
          ...saved._draft,
          validation: toSnapshot(nextReport)
        }
      };
      const persisted = await persist(verified, "validate");
      if (persisted) {
        setStatusMessage(
          nextReport.ok
            ? "草稿已保存并通过校验。"
            : "校验需要关注。"
        );
      }
    }
  };

  const approve = async (): Promise<void> => {
    if (dirty) {
      setActionError("请先保存更改再审核通过。");
      return;
    }
    const saved = await persist(draft, "validate");
    if (!saved) return;
    const nextReport = await validate();
    if (!nextReport || !nextReport.ok) return;
    const approved = await persist(
      {
        ...saved,
        _draft: {
          ...saved._draft,
          approved: true,
          validation: toSnapshot(nextReport)
        }
      },
      "approve"
    );
    if (approved) setStatusMessage("草稿已审核通过。");
  };

  const selectIssue = (issue: ValidationIssue): void => {
    if (!issue.field) return;
    const targetId = issue.field.startsWith("gold_answer_table")
      ? "table-editor-heading"
      : issue.field.startsWith("gold_answer_form")
        ? "form-editor-heading"
        : issue.field.startsWith("expected_keywords")
          ? "keyword-heading"
          : issue.field.startsWith("evidence") ||
              issue.field.startsWith("distractors")
            ? "evidence-heading"
            : "basic-fields-heading";
    document.getElementById(targetId)?.scrollIntoView({ block: "start" });
  };

  return (
    <section className="draft-page">
      <header className="draft-header">
        <div className="draft-title-group">
          <Link className="back-link" to={`/batch/${encodeURIComponent(batch)}`}>
            <ChevronLeft aria-hidden="true" size={15} />
            {batch}
          </Link>
          <div>
            <h1>{draft.id}</h1>
            <p className="section-meta">
              {draft._draft.extraction_health
                ? `提取状态 ${extractionLabel(draft._draft.extraction_health)}`
                : "草稿"}
              {dirty ? " · 有未保存更改" : ""}
              {draft._draft.approved ? " · 已审核" : ""}
            </p>
          </div>
        </div>
        <div className="draft-actions" aria-label="草稿操作">
          <button
            className="button button-secondary"
            disabled={pending !== undefined}
            onClick={save}
            type="button"
          >
            <Save aria-hidden="true" size={15} />
            {pending === "save" ? "正在保存" : "保存"}
          </button>
          <button
            className="button button-secondary"
            disabled={pending !== undefined}
            onClick={saveAndValidate}
            type="button"
          >
            <ShieldCheck aria-hidden="true" size={15} />
            {pending === "validate" ? "正在校验" : "保存并校验"}
          </button>
          <button
            className="button button-primary"
            disabled={approvalBlocked}
            onClick={approve}
            title={
              approvalBlocked && !dirty && !report
                ? "审核通过前请先校验草稿。"
                : undefined
            }
            type="button"
          >
            <Check aria-hidden="true" size={15} />
            {pending === "approve" ? "正在审核" : "审核通过"}
          </button>
        </div>
      </header>

      {actionError ? (
        <div className="inline-alert" role="alert">
          {actionError}
        </div>
      ) : null}
      {dirty && !pending ? (
        <p className="muted-text">请先保存更改再审核通过。</p>
      ) : null}
      {statusMessage ? (
        <p aria-live="polite" className="status-banner">
          {statusMessage}
        </p>
      ) : null}

      <div className="draft-workbench">
        <aside className="draft-column draft-column-evidence">
          <EvidencePane
            documents={documents}
            draft={draft}
            errors={errors}
            evidenceContentUrl={(filePath) =>
              typeof client.evidenceContentUrl === "function"
                ? client.evidenceContentUrl(filePath)
                : filePath
            }
            onDraftChange={updateDraft}
            onQuoted={(index, quote) =>
              updateDraft({
                ...draft,
                evidence: draft.evidence.map((evidence, current) =>
                  current === index ? { ...evidence, quote } : evidence
                )
              })
            }
            sources={sources}
          />
          {evidenceLoading ? <p className="muted-text">正在加载证据</p> : null}
          {evidenceError ? (
            <p className="field-error" role="alert">
              {evidenceError}
            </p>
          ) : null}
          {!resolveDraftSourcePath(draft) ? (
            <p className="muted-text">
              此草稿没有可用的 PDF 来源。
            </p>
          ) : null}
        </aside>
        <div className="draft-column draft-column-form">
          <BasicFields
            draft={draft}
            errors={errors}
            onChange={updateDraft}
          />
          <KeywordEditor
            errors={errors}
            keywords={draft.expected_keywords ?? []}
            onChange={(keywords) =>
              updateDraft({ ...draft, expected_keywords: keywords })
            }
            reachability={reachability}
          />
          {draft.answer_type === "table" || draft.type === "table" ? (
            <TableEditor
              onChange={(table) =>
                updateDraft({ ...draft, gold_answer_table: table })
              }
              table={draft.gold_answer_table}
            />
          ) : null}
          {draft.answer_type === "form" ? (
            <FormEditor
              form={draft.gold_answer_form}
              onChange={(form) =>
                updateDraft({ ...draft, gold_answer_form: form })
              }
            />
          ) : null}
          <ValidationPanel
            dirty={dirty}
            onIssueSelect={selectIssue}
            report={report}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * 把客户端校验结果统一为报告对象。
 *
 * @param result 批次结果或裸报告。
 * @returns 服务端校验报告。
 */
function asReport(result: ValidationReport | { validation: ValidationReport }): ValidationReport {
  return "validation" in result ? result.validation : result;
}

/**
 * 将完整校验报告压缩为草稿元信息快照。
 *
 * @param report 服务端报告。
 * @returns 草稿本地校验快照。
 */
function toSnapshot(report: ValidationReport): DraftValidationSnapshot {
  return {
    ok: report.ok,
    errors: report.errors,
    warnings: report.warnings,
    keywordResults: report.keywordResults,
    keywordSummary: report.keywordSummary
  };
}

/**
 * 将存储中的轻量校验快照还原为面板可展示的报告。
 *
 * @param snapshot 草稿本地快照。
 * @returns 完整报告；没有快照时为 undefined。
 */
function fromSnapshot(
  snapshot: DraftValidationSnapshot | undefined
): ValidationReport | undefined {
  if (!snapshot) return undefined;
  const keywordResults = snapshot.keywordResults.map((keyword) => ({
    ...keyword,
    normalizedKeyword:
      keyword.normalizedKeyword ??
      keyword.keyword.replace(/\s+/gu, "").toLowerCase()
  }));
  return {
    ok: snapshot.ok,
    errors: snapshot.errors,
    warnings: snapshot.warnings,
    keywordResults,
    keywordSummary:
      snapshot.keywordSummary ?? createKeywordValidationSummary(keywordResults)
  };
}

/**
 * 提取可展示的边界错误。
 *
 * @param error 捕获的异常。
 * @returns 稳定用户提示。
 */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "未知请求错误。";
}

/**
 * 把提取健康度枚举投影为中文标签。
 *
 * @param value 服务端提取健康度。
 * @returns 中文状态文本；未知值原样返回。
 */
function extractionLabel(value: unknown): string {
  if (value === "ok") return "正常";
  if (value === "degraded") return "降级";
  if (value === "failed") return "失败";
  return String(value);
}
