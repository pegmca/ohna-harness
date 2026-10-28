import { useState } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import type { MineCandidate } from "../../../core/types.js";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import type { GoldenStudioActionResult } from "../../shared/api/types.ts";
import { parseCandidateFile } from "./mine-candidates.js";

/** 候选文件读取状态。 */
type CandidateState =
  | { status: "empty" }
  | { status: "ready"; fileName: string; candidates: MineCandidate[] }
  | { status: "error"; message: string };

/** 挖掘动作状态。 */
type MineState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "running" }
  | { status: "success"; draftedCount: number; skippedCount: number; skipped: readonly MineSkipView[] }
  | { status: "error"; message: string };

/** 服务端返回的跳过摘要。 */
interface MineSkipView {
  id?: string;
  reason?: string;
  message?: string;
}

/**
 * 从浏览器选择的 JSON 候选文件创建草稿批次。
 *
 * @param props 数据客户端与批次刷新回调。
 * @returns 候选文件、确认框与真实结果摘要。
 */
export function MinePanel({
  client,
  onMined
}: {
  client: Pick<GoldenStudioClient, "runAction">;
  onMined: () => void | Promise<void>;
}) {
  const [batch, setBatch] = useState("");
  const [candidateState, setCandidateState] = useState<CandidateState>({
    status: "empty"
  });
  const [mineState, setMineState] = useState<MineState>({ status: "idle" });
  const running = mineState.status === "running";

  /**
   * 异步读取用户选择的文件并解析 CLI 同款候选格式。
   *
   * @param file 浏览器文件对象。
   */
  const selectFile = async (file: File | undefined): Promise<void> => {
    if (!file) {
      setCandidateState({ status: "empty" });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setCandidateState({
        status: "error",
        message: "Candidates file could not be read."
      });
      return;
    }
    const parsed = parseCandidateFile(text);
    setCandidateState(
      parsed.ok
        ? { status: "ready", fileName: file.name, candidates: parsed.candidates }
        : { status: "error", message: parsed.message }
    );
  };

  /**
   * 请求确认，避免一次误点就写入草稿目录。
   */
  const requestMine = (): void => {
    if (candidateState.status !== "ready" || !batch.trim()) return;
    setMineState({ status: "confirming" });
  };

  /**
   * 调用真实 server 动作并展示权威草稿/跳过结果。
   */
  const executeMine = async (): Promise<void> => {
    if (candidateState.status !== "ready") return;
    setMineState({ status: "running" });
    try {
      const response = await client.runAction("mine", {
        batch: batch.trim(),
        candidates: candidateState.candidates
      });
      const result = response.result;
      setMineState({
        status: "success",
        draftedCount: count(result.draftedCount),
        skippedCount: count(result.skippedCount),
        skipped: skippedRows(result.skipped)
      });
      await onMined();
    } catch (error) {
      setMineState({
        status: "error",
        message: error instanceof Error ? error.message : "Unknown mining failure."
      });
    }
  };

  return (
    <section aria-labelledby="mine-heading" className="mine-panel">
      <div className="mine-heading">
        <FileUp aria-hidden="true" size={18} />
        <div>
          <h2 id="mine-heading">Mine candidate drafts</h2>
          <p>Load the same JSON candidate array used by the CLI.</p>
        </div>
      </div>
      <div className="mine-form">
        <label className="field">
          <span className="field-label">Batch name</span>
          <input
            className="field-control"
            disabled={running}
            onChange={(event) => setBatch(event.target.value)}
            placeholder="candidates-2026-10"
            value={batch}
          />
        </label>
        <label className="field">
          <span className="field-label">Candidates JSON file</span>
          <input
            accept=".json,.jsonl,application/json"
            className="field-control"
            disabled={running}
            onChange={(event) => void selectFile(event.target.files?.[0])}
            type="file"
          />
        </label>
        <button
          className="button button-primary mine-submit"
          disabled={
            running ||
            candidateState.status !== "ready" ||
            batch.trim().length === 0
          }
          onClick={requestMine}
          type="button"
        >
          {running ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : null}
          {running ? "Mining candidates" : "Mine candidates"}
        </button>
      </div>
      <div aria-live="polite" className="mine-feedback">
        {candidateState.status === "ready" ? (
          <p className="muted-text">
            {candidateState.candidates.length}{" "}
            {candidateState.candidates.length === 1 ? "candidate" : "candidates"} ready
            {" from "}
            <code>{candidateState.fileName}</code>
          </p>
        ) : null}
        {candidateState.status === "error" ? (
          <p className="field-error" role="alert">{candidateState.message}</p>
        ) : null}
        {mineState.status === "success" ? (
          <MineSuccess state={mineState} />
        ) : null}
        {mineState.status === "error" ? (
          <p className="field-error" role="alert">{mineState.message}</p>
        ) : null}
      </div>
      {mineState.status === "confirming" ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            aria-labelledby="mine-confirm-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <div className="confirm-dialog-heading">
              <div>
                <p className="eyebrow">Confirm action</p>
                <h2 id="mine-confirm-title">Mine candidates?</h2>
              </div>
            </div>
            <p className="muted-text">
              The server will create a new draft batch from the selected candidates.
            </p>
            <div className="confirm-dialog-actions">
              <button
                className="button button-ghost"
                onClick={() => setMineState({ status: "idle" })}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                onClick={() => void executeMine()}
                type="button"
              >
                Mine candidates
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 渲染服务端返回的草稿与跳过统计。
 *
 * @param state 成功结果。
 * @returns 结果摘要与跳过原因。
 */
function MineSuccess({
  state
}: {
  state: Extract<MineState, { status: "success" }>;
}) {
  return (
    <div className="mine-result">
      <p className="action-message action-message-success">
        Mined {state.draftedCount} {state.draftedCount === 1 ? "draft" : "drafts"};
        skipped {state.skippedCount}
        {plural(state.skippedCount, "candidate")}
      </p>
      {state.skipped.length > 0 ? (
        <ul>
          {state.skipped.map((skip, index) => (
            <li key={`${skip.id ?? "candidate"}:${index}`}>
              <code>{skip.id ?? "candidate"}</code>
              <span>{skip.reason ?? "skipped"}</span>
              {skip.message ? <span>{skip.message}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 把未知服务端计数投影为非负整数。
 *
 * @param value 服务端字段。
 * @returns 可展示计数。
 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/**
 * 生成正确单复数，并把标点交给调用方以保持整句可读。
 *
 * @param value 计数。
 * @param singular 单数名词。
 * @returns 名词片段。
 */
function plural(value: number, singular: string): string {
  return value === 1 ? ` ${singular}.` : ` ${singular}s.`;
}

/**
 * 把服务端跳过列表投影为可展示行。
 *
 * @param value 服务端字段。
 * @returns 跳过摘要。
 */
function skippedRows(value: unknown): MineSkipView[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is MineSkipView =>
      typeof item === "object" && item !== null && !Array.isArray(item)
  );
}
