/**
 * Trace 行的视口惰性挂载（v2.0 渲染预算，docs/v2.0/04 §5.5 / §6）。
 *
 * 问题：TurnGroup 默认全部展开，而 `llm_call` 的 raw tab 含 providerPayload 全量 JSON；
 * 500+ 事件的 live run 若一次挂载全部调用块，首帧会钉住主线程。`JsonViewer` 自带的
 * 节点级折叠只能约束「单棵 JSON 树」的规模，约束不了「整页有多少个调用块」。
 *
 * 方案：每个 `LlmCallBlock` 外面套一个占位容器（带 `content-visibility: auto` 与
 * `contain-intrinsic-size` 的 `.trace-row-slot`），用 IntersectionObserver 判定它是否接近视口：
 * - 接近（默认提前 400px 预取）→ 挂载真实调用块，此后**保持挂载**：折叠/展开是用户的
 *   显式选择，滚动往返不应丢状态；
 * - 调用方如需复用同一个占位容器承载另一条记录，必须换 `key` 重建，避免旧展开状态串台；
 * - 观测器缺失（jsdom / 老浏览器）→ 视为「立即进入视口」，功能优先于预算。
 *
 * 未挂载分支**不是空占位**：它渲染 `LlmCallSummaryRow`（`#N · model · durationMs · in ·
 * out · cost`，失败时带 `stopReason` 徽标），所以滚过未预取的区域看到的是可读摘要条而不是
 * 白块，`.trace-row-slot` 的 `contain-intrinsic-size` 正好贴合摘要行高度、滚动条不跳。
 * 该分支无法靠 jsdom 自然触发（没有 IntersectionObserver 即视为在视口内），因此
 * `eager={false}` 之外还留了 `forcePlaceholder` 只用于让这条分支可测。
 */
import type { LlmCallRecordDto } from "@aiagent/types";
import { useEffect, useRef, useState } from "react";
import { LlmCallBlock, LlmCallSummaryRow } from "./LlmCallBlock";

/** 视口预取边距：提前约 400px 挂载，滚动时不出现明显白块。 */
const VIEWPORT_ROOT_MARGIN = "400px 0px";

/**
 * 判断当前环境是否具备 IntersectionObserver。
 *
 * @returns true 表示可做视口观测。
 */
export function hasIntersectionObserver(): boolean {
  return typeof IntersectionObserver === "function";
}

/**
 * 视口内才算「已激活」的布尔状态（只升不降）。
 *
 * @param enabled 是否启用观测（false 时立即激活，用于测试与强制挂载）。
 * @returns `[ref, active]`：把 ref 挂到占位元素上。
 */
export function useInView(enabled = true): [(node: HTMLElement | null) => void, boolean] {
  const [active, setActive] = useState(!enabled || !hasIntersectionObserver());
  const nodeRef = useRef<HTMLElement | null>(null);
  const setNode = (node: HTMLElement | null): void => {
    nodeRef.current = node;
  };

  useEffect(() => {
    if (!enabled || active) return;
    const node = nodeRef.current;
    if (!node || !hasIntersectionObserver()) {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: VIEWPORT_ROOT_MARGIN }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, active]);

  return [setNode, active];
}

/**
 * 视口惰性挂载的 LLM 调用块（视口外只渲染摘要行）。
 *
 * @param props.record 采集记录。
 * @param props.idSuffix DOM id 后缀（保持同一 run 内 aria id 唯一）。
 * @param props.eager true 表示跳过视口判定直接挂载（测试与「用户已聚焦」场景）。
 * @param props.forcePlaceholder 仅供测试：强制走未挂载分支（jsdom 无观测器时该分支不可达）。
 * @returns 占位容器 + 摘要行或完整调用块。
 */
export function VirtualizedLlmCallBlock(props: {
  record: LlmCallRecordDto;
  idSuffix?: string;
  eager?: boolean;
  forcePlaceholder?: boolean;
}) {
  const [setNode, inView] = useInView(!props.eager);
  const active = inView && props.forcePlaceholder !== true;
  return (
    <div className="trace-row-slot" data-mounted={active ? "true" : "false"} ref={setNode}>
      {active ? (
        <LlmCallBlock idSuffix={props.idSuffix} record={props.record} />
      ) : (
        <section aria-label="LLM 调用" className={`trace-llm ${props.record.error ? "has-error" : ""}`}>
          <LlmCallSummaryRow record={props.record} />
        </section>
      )}
    </div>
  );
}
