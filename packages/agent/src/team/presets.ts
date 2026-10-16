/**
 * 便捷构造器：bull / bear / risk 三方评审团队（roadmap 阶段五演示）。
 *
 * 三个成员各自持独立上下文与角色 system prompt，只授予只读工具子集（权限最小化），
 * 由 supervisor 用 SendMessage 并发/顺序派发同一课题，最后汇总多视角结论。
 */
import type { Api, Model } from "@aiagent/ai";
import type { TeamController } from "./controller.js";
import type { TeamControllerOptions, TeamCreateParams } from "./types.js";
import { createTeamController } from "./controller.js";

/** createBullBearRiskTeam 的选项：在 TeamControllerOptions 基础上增加可选成员模型与只读工具。 */
export interface BullBearRiskOptions extends TeamControllerOptions {
  /** 各成员专用模型（成本路由）；缺省用 defaultModel。 */
  memberModels?: Partial<Record<"bull" | "bear" | "risk", Model<Api>>>;
  /** 授予三成员的只读工具名子集（权限最小化）。 */
  readOnlyTools?: string[];
}

/** 三个角色的固定配置（角色 + 专属 system prompt）。 */
const PRESETS: ReadonlyArray<{ key: "bull" | "bear" | "risk" } & Pick<TeamCreateParams, "name" | "role" | "systemPrompt">> = [
  {
    key: "bull",
    name: "bull",
    role: "多头 / 乐观评审",
    systemPrompt:
      "你是乐观的多头评审。聚焦标的上行催化剂、被低估的价值与可执行的多头证据，用数据支撑你的乐观判断，指出悲观论点的薄弱处。",
  },
  {
    key: "bear",
    name: "bear",
    role: "空头 / 悲观评审",
    systemPrompt:
      "你是审慎的空头评审。聚焦下行风险、估值泡沫、基本面隐患与未定价的尾部情景，用证据拆解乐观叙事，指出多头论点的脆弱处。",
  },
  {
    key: "risk",
    name: "risk",
    role: "风控 / 合规模审",
    systemPrompt:
      "你是独立的风险与合规评审。聚焦头寸风险、流动性、合规边界、对冲与止损纪律，给出可落地的风险控制建议，不参与方向判断。",
  },
];

/**
 * 创建一个预置了 bull / bear / risk 三成员的 TeamController。
 *
 * @param options 基础 controller 选项 + 可选成员模型与只读工具。
 * @returns 已 seed 三个成员的 TeamController。
 */
export function createBullBearRiskTeam(options: BullBearRiskOptions): TeamController {
  // 演示默认值：最小并发 3（同进程 worker 池跑通拓扑），单成员成本上限 $0.05——
  // 让 bull/bear/risk 评审任务带真实成本护栏数字，对应「多代理贵必须收口」的叙事。
  const controller = createTeamController({
    ...options,
    maxConcurrentMembers: options.maxConcurrentMembers ?? 3,
    budget: options.budget ?? { maxCostPerMember: 0.05, maxTokensPerMember: 200_000 },
  });
  const { memberModels, readOnlyTools } = options;

  for (const preset of PRESETS) {
    controller.createMember({
      name: preset.name,
      role: preset.role,
      modelObject: memberModels?.[preset.key],
      tools: readOnlyTools,
      systemPrompt: preset.systemPrompt,
    });
  }

  return controller;
}
