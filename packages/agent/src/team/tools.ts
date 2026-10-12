/**
 * 两个编排原语 TeamCreate / SendMessage 的 AgentTool 实现（P3）。
 *
 * 它们都是「工具」而非「内建 loop 逻辑」：supervisor 的 model 自行决定何时 spawn 成员、
 * 何时向谁派发任务（动态决策，而非预定义 workflow）。工具只负责 mutate team 状态 /
 * 触发子代理运行，全部结构化错误回传，不抛异常拖垮 supervisor。
 *
 * 注意：`AgentToolResult` 协议不含 `isError` 字段（isError 由 loop 依据「执行是否抛异常 /
 * afterToolCall 覆盖」判定）。故失败以「可读文本 content」表达——TeamCreate 失败时直接
 * throw（loop 自动转 isError ToolResultMessage）；SendMessage 的子代理失败以普通文本回传
 * （isError:false 让 supervisor 自行决策，见 ）。
 */
import { z } from "zod";
import type { AgentTool, AgentToolResult } from "@aiagent/tools";
import type { TeamCreateParams, SubagentResult } from "./types.js";

/** 工具所需的 controller 能力（最小依赖面，避免运行时循环依赖）。 */
export interface TeamToolDeps {
  createMember: (params: TeamCreateParams) => unknown;
  runMember: (name: string, content: string, signal?: AbortSignal) => Promise<SubagentResult>;
}

/** TeamCreate 参数 schema。 */
const teamCreateSchema = z.object({
  name: z.string().describe("子代理唯一名称（消息总线寻址键）"),
  role: z.string().describe("角色描述，如「多头评审」「风控评审」"),
  model: z.string().optional().describe("模型 id；省略时用 controller 默认 model（成本路由由 supervisor 决定）"),
  tools: z.array(z.string()).optional().describe("授权工具名子集（权限最小化）"),
  systemPrompt: z.string().optional().describe("角色 system prompt 覆盖"),
});

/** SendMessage 参数 schema。 */
const sendMessageSchema = z.object({
  recipient: z.string().describe("接收成员名称"),
  content: z.string().describe("委派给该成员的任务 / 消息正文"),
});

/**
 * TeamCreate 原语：创建一个隔离子代理 = 一条独立 `agentLoop` 配置（独立 model / 工具子集）。
 * 成功后回写 team 状态，返回可读确认文本；失败直接 throw（loop 转 isError 回喂 supervisor）。
 *
 * @param deps 提供 createMember 的 controller 句柄。
 * @returns 可注册进 supervisor `context.tools` 的 AgentTool。
 */
export function createTeamCreateTool(deps: TeamToolDeps): AgentTool<typeof teamCreateSchema> {
  return {
    name: "TeamCreate",
    description:
      "创建一个隔离子代理成员（独立上下文窗口与模型）。参数包含名称、角色、可选 model id、可选授权工具子集与角色 system prompt。",
    label: "组建子代理",
    parameters: teamCreateSchema,
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      const member = deps.createMember(params as TeamCreateParams) as {
        name: string;
        role: string;
        model: { id: string };
      };
      return {
        content: [
          {
            type: "text",
            text: `已创建成员 ${member.name}（角色：${member.role}，model：${member.model.id}）。后续可用 SendMessage 向其派发任务。`,
          },
        ],
        details: { member },
      };
    },
  };
}

/**
 * SendMessage 原语：向某成员派发任务，懒执行其 subagent（一次独立 `agentLoop`），
 * 回收摘要作为工具结果返回 supervisor。
 *
 * 失败处理选择（见 ）：以「可读错误文本 + isError:false」回传，
 * 让 supervisor 自行决策是否重试 / 换人 / 汇总，而非让 loop 直接中断。
 *
 * @param deps 提供 runMember 的 controller 句柄。
 * @returns 可注册进 supervisor `context.tools` 的 AgentTool。
 */
export function createSendMessageTool(deps: TeamToolDeps): AgentTool<typeof sendMessageSchema> {
  return {
    name: "SendMessage",
    description: "向团队成员派发一条任务消息，触发其隔离 subagent 运行并回收摘要。失败以可读文本回传，不中断 supervisor。",
    label: "向成员发消息",
    parameters: sendMessageSchema,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult> {
      const result = await deps.runMember(params.recipient, params.content, signal);
      const text =
        result.status === "failed"
          ? `子代理 ${result.member} 执行失败：${result.error?.message ?? "unknown"}${
              result.summary ? `\n部分摘要：${result.summary}` : ""
            }`
          : `子代理 ${result.member} 已完成。\n摘要：${result.summary}\n产物：${
              result.artifacts.length ? result.artifacts.join("；") : "无"
            }`;
      return { content: [{ type: "text", text }], details: result };
    },
  };
}
