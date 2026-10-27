/**
 * 编队森林小卡（docs/v2.0/04 §5.5）：每个 agent 一张玻璃小卡（label + role + 运行中绿点）。
 *
 * 交互语义（刻意如此）：
 * - **点击不隐藏任何行**，只高亮该 agent 的跨度并滚动到它跨度的首行——执行地图的可探索性
 *   来自「看得到全局」，折叠/过滤会让用户误以为子代理没跑；
 * - 运行中绿点 = 该 agent 有 `agent_start` 但没有 `agent_end`；run 已结束时不再亮；
 * - 小卡顺序 = agent 首次出现的顺序（TeamCards 不按字母重排，便于和事件流对照）。
 *
 * 视觉：`.md-glass` + `.trace-team-card`，运行中/选中用既有 `--md-color-primary`（#89D7B7）。
 */
import { Users } from "lucide-react";
import { isTeamRun, type TraceSpans } from "./trace-spans";

/** TeamCards 的属性。 */
export interface TraceTeamCardsProps {
  /** 跨度集合（含父子关系与首尾锚点）。 */
  spans: TraceSpans;
  /** 当前高亮的 agentId（点击后由抽屉写入）。 */
  activeAgentId: string | undefined;
  /** run 是否仍在运行（决定「运行中绿点」是否可能亮起）。 */
  isLive: boolean;
  /** 点击某张卡：高亮 + 滚动到该 agent 跨度的首行。 */
  onSelect(agentId: string): void;
}

/**
 * 判断某个 agent 是否仍在运行（green dot）。
 *
 * 首选判据是跨度层的 `closed` 标记（收到 `agent_end` 即熄灯）；由于 `closed` 是可选的内部
 * 标记，外部构造的跨度集合退回「结束锚点是否落后于全局最后一次活动」的保守推断：
 * 子代理结束后主线程还会继续调 LLM / 工具，落后的那个就不该再亮绿点。
 *
 * @param agentId 目标 agent。
 * @param spans 跨度集合。
 * @param isLive run 是否仍在运行。
 * @returns true 表示显示运行中绿点。
 */
export function isAgentRunning(agentId: string, spans: TraceSpans, isLive: boolean): boolean {
  if (!isLive) return false;
  const span = spans.agents.get(agentId);
  if (!span) return false;
  let globalEnd = 0;
  for (const item of spans.agents.values()) globalEnd = Math.max(globalEnd, item.endSeq);
  return span.closed !== true && span.endSeq >= globalEnd;
}

/**
 * 渲染编队森林。
 *
 * @param props 见 `TraceTeamCardsProps`。
 * @returns 成员小卡列表。
 */
export function TraceTeamCards(props: TraceTeamCardsProps) {
  const agents = [...props.spans.agents.values()];
  // 单 run 退化为单 root 跨度：只渲染「一个成员的编队」没有信息量，整体不渲染
  //（抽屉层同样用 isTeamRun 把关，这里是组件自保护，任一入口都不会出现单卡编队）。
  if (!isTeamRun(props.spans)) return null;
  return (
    <section aria-label="Team 成员" className="trace-team-cards">
      <p className="md-label">
        <Users className="icon-size" aria-hidden /> Fleet
      </p>
      <div className="trace-team-card-row" role="list">
        {agents.map((agent) => {
          const running = isAgentRunning(agent.agentId, props.spans, props.isLive);
          const active = agent.agentId === props.activeAgentId;
          return (
            <button
              aria-label={`定位 ${agent.label}`}
              aria-pressed={active}
              className={`md-glass trace-team-card ${active ? "is-active" : ""}`}
              data-agent-key={agent.agentId}
              key={agent.agentId}
              onClick={() => props.onSelect(agent.agentId)}
              role="listitem"
              type="button"
            >
              <span className="trace-team-card-label">
                {running ? <span className="trace-live-dot" aria-label="运行中" /> : null}
                {agent.label}
              </span>
              <span className="trace-team-card-role">{agent.role || "agent"}</span>
              {agent.modelId ? <span className="trace-team-card-model">{agent.modelId}</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
