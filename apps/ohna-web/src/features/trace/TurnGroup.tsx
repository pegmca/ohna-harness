/**
 * 执行地图的 turn 分组（docs/v2.0/04 §5.5）：可折叠的 `turn → [message/tool/llm/terminal]`。
 *
 * 分组口径（与 `trace-spans.ts` 同一条规则）：每一行归到「承载它的 turn」——
 * 该行之前没有本 agent 的 turn_start 时（run 前导段：用户消息、context_event 等），
 * 归到**紧随其后的第一个本 agent turn**；已经开过轮的行归到最近一次经过的 turn。
 * `Before first turn` 只是「该 agent 确实一条 turn_start 都没有」时的合法退化桶（标题用
 * `turnIndex = -1` 表达），不是前导段的常态。run 级终态横条不进入任何 turn，单独成尾段。
 *
 * 渲染预算：TurnGroup **默认全部展开**，单个 turn 的行数超过阈值时先渲染前 N 行并给出
 * 「再显示 N 行」按钮。口径要说清两层：
 * 1. 预算只限制**首屏批量**，超出部分按 `TURN_RENDER_BATCH` 一批批追加，**没有硬上限**——
 *    点 r 次「再显示」后挂载的就是 `TURN_RENDER_BUDGET + r × TURN_RENDER_BATCH` 个非 context 行；
 * 2. 真正兜住「巨型 turn 钉住整页」的是行内的 `VirtualizedLlmCallBlock` 视口惰性挂载，
 *    且它**只在存在 IntersectionObserver 的浏览器里生效**。在无该 API 的环境（jsdom / SSR /
 *    老浏览器）里观测器缺失即等于「全部在视口内」，此时点满「再显示」会把整个 turn 铺进 DOM。
 *    换言之「不会钉住整页」只是真实浏览器的性质，不是本组件的保证，也不能当作无观测器
 *    环境的断言前提。
 *
 * compaction 行的可见性：context_event 是「窗口为什么一开始就小」的唯一解释，因此带 context
 * 行的桶里这些行**无条件进入可见区**，不受行预算折叠（见 `splitByBudget`）。但它**不置顶**：
 * `.trace-*` 的行序就是时间序，上下文事件是时间轴上的一条记录，挪到 turn 顶部会破坏
 * 「按事件顺序阅读」。可见行因此仍按原始行序排列——context 行真实位置多靠后就排多靠后。
 */
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { formatNumber, SUPERVISOR_AGENT_ID } from "./trace-labels";
import type { TraceRow } from "./trace-projection";
import { TraceRowList } from "./TraceStream";

/** 单 turn 一次铺进 DOM 的最大行数（超出部分点「再显示」增量展开）。 */
export const TURN_RENDER_BUDGET = 40;

/** 「再显示」每次追加的行数。 */
export const TURN_RENDER_BATCH = 40;

/** 一个 turn 分组。 */
export interface TurnBucket {
  /** 稳定键（`agentId:turnIndex` 或 run 前导/收尾段）。 */
  key: string;
  /** 分组标题（`Turn N` / `Run start` / `Run end`）。 */
  title: string;
  /** 归属 agent（Team 场景下主线程与子代理的 turn 各自成组）。 */
  agentId: string;
  /** turn 序号；-1 表示不属于任何 turn 的前导/收尾段。 */
  turnIndex: number;
  /** 分组内的行。 */
  rows: TraceRow[];
  /** 是否包含终态行（失败时标题加左侧色条）。 */
  isFailed: boolean;
  /** 是否仍在运行中（live 时最后一个 turn 显示 "● running"）。 */
  isRunning: boolean;
}

/**
 * 判断一行是否代表一次失败（用于给 turn 打失败标记）。
 *
 * 三类信号：`llm_call` 记录带 error、工具执行 `isError`（或被标记失败）、终态行 status 为 failed。
 *
 * @param row 投影行。
 * @returns true 表示该行是错误信号。
 */
function hasRowError(row: TraceRow): boolean {
  if (row.kind === "terminal") return row.status === "failed";
  if (row.kind === "tool") return row.isError === true;
  if (row.kind === "llm") return Boolean(row.record.error);
  return false;
}

/**
 * 把投影行按 turn 分桶（纯函数，可单测）。
 *
 * @param rows 按事件顺序排列的投影行。
 * @param events 对应的事件流（取 turn_start/turn_end 的 sequence 锚点做切分）。
 * @returns 按顺序排列的 turn 桶；终态行单独作为 `run-end` 桶放在最后。
 */
export function bucketRowsByTurn(
  rows: readonly TraceRow[],
  events: readonly RunStreamEventDtoV2[]
): TurnBucket[] {
  // 事件 sequence → (agentId, turnIndex) 归属；内容行按「最近一次经过的 turn」归桶。
  const rowSeq = new Map<string, number>();
  for (const event of events) {
    rowSeq.set(`msg-${event.sequence}`, event.sequence);
    rowSeq.set(`llm-${event.sequence}`, event.sequence);
    rowSeq.set(`context-${event.sequence}`, event.sequence);
    rowSeq.set(`status-${event.sequence}`, event.sequence);
    rowSeq.set(`error-${event.sequence}`, event.sequence);
    const payload = (event.payload ?? {}) as { toolCallId?: string };
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      rowSeq.set(`tool-${payload.toolCallId ?? event.sequence}`, event.sequence);
    }
  }

  const buckets = new Map<string, TurnBucket>();
  const order: string[] = [];
  /** supervisor 的「最近一次经过的 turn」：turn 之间/之后的游离行归到它。 */
  let current: { agentId: string; turnIndex: number } | undefined;
  let bucketForCurrent: string | undefined;

  const ensure = (agentId: string, turnIndex: number): TurnBucket => {
    const key = `${agentId}:${turnIndex}`;
    const existing = buckets.get(key);
    if (existing) return existing;
    // `turnIndex < 0` 是**合法退化桶**，不是前导段的常态：只有「该 agent 确实一条 turn_start
    // 都没有」时才会落到这里（见下方 owner 判定）。supervisor 显示为 Before first turn。
    const title =
      turnIndex < 0
        ? agentId === "run"
          ? "Run end"
          : agentId === SUPERVISOR_AGENT_ID
            ? "Before first turn"
            : `${agentId} · before first turn`
        : agentId === SUPERVISOR_AGENT_ID
          ? `Turn ${turnIndex + 1}`
          : `${agentId} · Turn ${turnIndex + 1}`;
    const bucket: TurnBucket = {
      key,
      title,
      agentId,
      turnIndex,
      rows: [],
      isFailed: false,
      isRunning: false
    };
    buckets.set(key, bucket);
    order.push(key);
    return bucket;
  };

  // 锚点收集：**每次 turn_start 都保留一条**，不做 (agentId, turnIndex) 去重——
  // 续传重放会让同一 turn 出现两次 turn_start，若按 key 覆盖成「最后一次」（或按排序取到
  // 较早那次），该 turn 之后的所有行都会失去 owner，从而退化成「按最近一次经过的 turn 归桶」，
  // 最终把主线程的行塞进子代理的 turn 桶里。这里保留全部锚点，再按 sequence 升序扫描。
  const anchors: Array<{ agentId: string; turnIndex: number; sequence: number; type: string }> = [];
  for (const event of events) {
    if (event.type === "turn_start" || event.type === "turn_end") {
      const payload = (event.payload ?? {}) as { agentId?: string; turnIndex?: number };
      const agentId =
        typeof payload.agentId === "string" && payload.agentId ? payload.agentId : SUPERVISOR_AGENT_ID;
      const turnIndex = typeof payload.turnIndex === "number" ? payload.turnIndex : 0;
      anchors.push({ agentId, turnIndex, sequence: event.sequence, type: event.type });
    }
  }
  // 直接保留锚点对象，不做字符串编码再 split 解析：agentId 里可能含 `:`，
  // 拼串再拆会把 agentId 截断、turnIndex 变成 NaN，owner 判定静默失效后退化成串台。
  const sortedAnchors = [...anchors].sort((left, right) => left.sequence - right.sequence);

  for (const row of rows) {
    const seq = rowSeq.get(row.key) ?? -1;
    if (row.kind === "terminal") {
      const endBucket = ensure("run", -2);
      endBucket.rows.push(row);
      endBucket.isFailed = endBucket.isFailed || row.status === "failed";
      continue;
    }
    // 沿锚点顺序推进「当前 turn」：只对缺失锚点的行（如兜底终态）使用。
    let owner: { agentId: string; turnIndex: number } | undefined;
    for (const anchor of sortedAnchors) {
      if (anchor.sequence > seq) break;
      if (anchor.type !== "turn_start") continue;
      if (anchor.agentId === row.agentId) owner = { agentId: anchor.agentId, turnIndex: anchor.turnIndex };
    }
    if (!owner) {
      // 没有「承载它的 turn」（该行之前没有本 agent 的 turn_start，或该行没有 sequence 锚点）。
      // 口径只有一条：**该 agent 此前一次 turn 都还没开始时，前导段并入紧随其后的首个 turn**
      // （视觉上属于「本轮的输入」）；一旦已经有过 turn，就归到最近一次经过的 turn。
      // 这个判定用「此前是否出现过该 agent 的 turn_start」而不是 `current === undefined`：
      // `current` 只在 supervisor 有行时被推进，子代理桶被跳过时它可能是陈旧的，
      // 而在 supervisor 首个 turn 之前就出现了 supervisor 行时它又恰好为空——
      // 两种反例都会让「并入首个 turn」作用到本不该属于它的行（把第二个 turn 的行挪走）。
      const hasEarlierTurn = sortedAnchors.some(
        (anchor) =>
          anchor.type === "turn_start" && anchor.agentId === row.agentId && anchor.sequence <= seq
      );
      let ownerCandidate: { agentId: string; turnIndex: number } | undefined;
      if (!hasEarlierTurn) {
        // 尚未开轮：归到紧随其后的第一个本 agent turn（找不到则不造 turn，退化为 turnIndex -1）。
        const next = sortedAnchors.find(
          (anchor) => anchor.sequence > seq && anchor.type === "turn_start" && anchor.agentId === row.agentId
        );
        if (next) ownerCandidate = { agentId: row.agentId, turnIndex: next.turnIndex };
      }
      // `current` 只代表 **supervisor** 最近经过的 turn，因此只对 supervisor 的行生效；
      // 子代理没有自己的 turn 时进它自己的 `turnIndex:-1` 退化桶，不能继承主线程的 turn
      // 序号（否则子代理的行会挂到「Turn N」标题下，与主线程串台）。
      const fallbackCurrent =
        row.agentId === SUPERVISOR_AGENT_ID && current?.agentId === SUPERVISOR_AGENT_ID ? current : undefined;
      owner = ownerCandidate ?? fallbackCurrent ?? { agentId: row.agentId, turnIndex: -1 };
    }
    if (owner.agentId === SUPERVISOR_AGENT_ID) {
      current = owner;
      bucketForCurrent = `${owner.agentId}:${owner.turnIndex}`;
    }
    const bucket = ensure(owner.agentId, owner.turnIndex);
    bucket.rows.push(row);
    // 失败 turn 的左色条：turn 内出现错误行（LLM 调用失败 / 工具报错 / 失败终态）即判定。
    if (hasRowError(row)) bucket.isFailed = true;
    if (bucketForCurrent && buckets.has(bucketForCurrent)) {
      buckets.get(bucketForCurrent)!.isRunning = false;
    }
  }

  // 空桶（只有 turn_start/turn_end、没有行）不渲染：执行地图只展示有内容的分组。
  const result = order
    .map((key) => buckets.get(key))
    .filter((bucket): bucket is TurnBucket => bucket !== undefined && bucket.rows.length > 0);

  // 终态之前的最后一个 supervisor turn 标记为 running（live 时抽屉追加 "● running"）。
  const lastSupervisor = [...result]
    .reverse()
    .find((bucket) => bucket.agentId === SUPERVISOR_AGENT_ID && bucket.turnIndex >= 0);
  if (lastSupervisor) lastSupervisor.isRunning = true;
  return result;
}

/**
 * 按行预算切分单个分组的行，并保证 compaction 行永远在可见区。
 *
 * 为什么单独处理 context 行：执行地图里「窗口为什么一开始就小」只有 compaction 那个横条能解释，
 * 而前缀桶/巨型 turn 的行数可以轻易超过 `TURN_RENDER_BUDGET`（一次 run 的 llm_call 就能到几十上百）。
 * 若只是 `slice(0, budget)`，✂ 行会被挤到「再显示 N 行」按钮之后，等于这条主线在真实 run 上不可见。
 *
 * 口径（原位，不置顶）：可见区 = 「前 budget 个非 context 行」∪「全部 context 行」，
 * 再**按原始下标排序**输出——context 行落在它真实的时间位置，而不是被提到可见区首位。
 * hidden 只含非 context 行，因此 context 行不会在 hidden 里重复出现。
 * 置顶会把时间轴上的一条记录挪到 turn 顶部，破坏 `.trace-*` 的「按事件顺序阅读」。
 *
 * @param rows 分组内全部行（已按 sequence 升序）。
 * @param budget 本次允许展示的非 context 行上限。
 * @returns `visible` 可见行（含全部 context 行，按原始行序）、`hidden` 待追加行（原始行序）、
 * `remaining` 剩余未展示行数（= `hidden.length`，只计非 context 行——context 行从不入 hidden）。
 */
export function splitByBudget(
  rows: readonly TraceRow[],
  budget: number
): { visible: TraceRow[]; hidden: TraceRow[]; remaining: number } {
  const limit = Math.max(budget, 0);
  const visible: TraceRow[] = [];
  const hidden: TraceRow[] = [];
  let shownRest = 0;
  // 单趟扫描：context 行无条件可见，其余行按上限计入可见区，超出部分进 hidden。
  // 这样 visible/hidden 天然保持原始行序，context 行也留在原位（不被重排）。
  for (const row of rows) {
    if (row.kind === "context") {
      visible.push(row);
      continue;
    }
    if (shownRest < limit) {
      visible.push(row);
      shownRest += 1;
      continue;
    }
    hidden.push(row);
  }
  return { visible, hidden, remaining: hidden.length };
}

/** TurnGroup 列表的属性。 */
export interface TurnGroupListProps {
  /** 全部投影行。 */
  rows: TraceRow[];
  /** 事件流（分桶锚点）。 */
  events: readonly RunStreamEventDtoV2[];
  /** 选中高亮的 agentId（TeamCards 点击后写入）。 */
  activeAgentId: string | undefined;
  /** 是否仍在运行（"● running"）。 */
  isLive: boolean;
  /**
   * 预置的分组（仅供防御分支的注入测试使用：正常渲染恒由 `rows` + `events` 现算）。
   *
   * 为什么留这个入口：「有行却零分组」在分桶规则正确时**不可达**（每行必然进某个桶或
   * Run end 桶），但它正因不可达而无法靠渲染自然触发；若不留注入点，这条防御分支就只剩
   * 恒真断言（`hasBuckets || hasHint`）可写，等于没有守护。
   */
  buckets?: TurnBucket[];
}

/**
 * 判定「有行却零分组」的防御态：投影出了行，但分桶一条都没产出。
 *
 * 抽成纯函数是为了让它可被直接断言。这是**纯防御分支**：正常分桶下每行必然进入某个
 * 桶（终态行进 Run end），因此这里只在分桶规则被改坏（误加 `filter` / 提前 `slice`）时
 * 成立。它不是可达的运行时状态，而是「不能静默渲染一片空白」的保险丝。
 *
 * @param rowCount 投影行条数。
 * @param bucketCount 分桶条数。
 * @returns true 表示需要渲染「未能归入任何 turn 分组」的提示。
 */
export function needsUngroupedHint(rowCount: number, bucketCount: number): boolean {
  return rowCount > 0 && bucketCount === 0;
}

/**
 * 渲染按 turn 分组的执行地图。
 *
 * @param props 见 `TurnGroupListProps`。
 * @returns turn 分组列表（失败 turn 带 `.trace-turn.is-failed`）。
 */
export function TurnGroupList(props: TurnGroupListProps) {
  const buckets = useMemo(
    () => props.buckets ?? bucketRowsByTurn(props.rows, props.events),
    [props.rows, props.events, props.buckets]
  );
  // 有行却零分组是投影与分桶不一致的信号，不能静默渲染一片空白（`slice/过滤` 类改动很容易造成它）。
  if (needsUngroupedHint(props.rows.length, buckets.length)) {
    return <p className="muted-row trace-empty">该 run 有 {formatNumber(props.rows.length)} 条事件，但未能归入任何 turn 分组。</p>;
  }
  if (buckets.length === 0) return null;
  return (
    <div className="trace-turns">
      {buckets.map((bucket) => (
        <TurnGroup
          activeAgentId={props.activeAgentId}
          bucket={bucket}
          isLive={props.isLive}
          key={bucket.key}
        />
      ))}
    </div>
  );
}

/**
 * 单个 turn 分组（可折叠，默认展开）。
 *
 * @param props.bucket 分组数据。
 * @param props.activeAgentId 高亮的 agent（TeamCards 联动）。
 * @param props.isLive run 是否仍在运行。
 * @returns turn 块。
 */
export function TurnGroup(props: {
  bucket: TurnBucket;
  activeAgentId: string | undefined;
  isLive: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [budget, setBudget] = useState(TURN_RENDER_BUDGET);
  // context 行（compaction 横条）无条件可见但保持原位，其余行按预算分批追加。
  const { visible: visibleRows, remaining } = splitByBudget(props.bucket.rows, budget);
  const isRunning = props.isLive && props.bucket.isRunning && props.bucket.turnIndex >= 0;
  const className = [
    "trace-turn",
    props.bucket.isFailed ? "is-failed" : "",
    props.activeAgentId === props.bucket.agentId ? "is-active" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section aria-label={props.bucket.title} className={className}>
      <button
        aria-expanded={!collapsed}
        className="trace-turn-head"
        onClick={() => setCollapsed((value) => !value)}
        type="button"
      >
        <ChevronDown className={`icon-size details-chevron ${collapsed ? "" : "is-open"}`} />
        <span className="trace-turn-title">{props.bucket.title}</span>
        <span className="trace-turn-meta">{formatNumber(props.bucket.rows.length)} rows</span>
        {isRunning ? <span className="trace-live-dot" aria-label="running" /> : null}
        {props.bucket.isFailed ? <span className="md-badge md-badge-danger">failed</span> : null}
      </button>
      {collapsed ? null : (
        <div className="trace-turn-body">
          {/* 行级联动：选中 agent 的行提亮（`.is-agent-active`），其余行照常渲染，不隐藏。 */}
          <TraceRowList activeAgentId={props.activeAgentId} rows={visibleRows} />
          {remaining > 0 ? (
            <button
              className="md-button md-button-secondary md-button-sm trace-turn-more"
              onClick={() => setBudget((value) => value + TURN_RENDER_BATCH)}
              type="button"
            >
              再显示 {formatNumber(Math.min(remaining, TURN_RENDER_BATCH))} 行（剩余 {formatNumber(remaining)}）
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
