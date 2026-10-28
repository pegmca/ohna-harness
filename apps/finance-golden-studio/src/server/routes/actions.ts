import { generateEvalDataset } from "../../core/generate.js";
import { mineCandidates } from "../../core/mine.js";
import { promoteBatch } from "../../core/promote.js";
import {
  validateDraftBatch,
  validateDraftDraft
} from "../../core/validate-batch.js";
import { validateGolden } from "../../core/validate.js";
import { readJsonBody } from "../body.js";
import { HttpError } from "../errors.js";
import {
  readActionBody,
  readBatchSegment,
  readDraftSegment,
  readMineBody
} from "../paths.js";
import type { RequestContext, RouteResult } from "../types.js";

/**
 * 处理校验、发布与评测集生成动作。
 *
 * @param context 请求上下文。
 * @param segments API 路径段。
 * @returns 路由响应；未匹配时为 undefined。
 */
export async function handleActions(
  context: RequestContext,
  segments: readonly string[]
): Promise<RouteResult> {
  if (!(segments.length === 2 && segments[0] === "actions")) {
    return undefined;
  }
  if (context.request.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "Use POST for this route.", {
      allowed: "POST"
    });
  }
  const action = segments[1];
  switch (action) {
    case "validate": {
      const body = readActionBody(await readJsonBody(context.request, context.maxBodyBytes));
      return { kind: "json", status: 200, body: { ok: true, data: await validateAction(context, body) } };
    }
    case "promote": {
      const body = readActionBody(await readJsonBody(context.request, context.maxBodyBytes));
      if (!body.batch) {
        throw new HttpError(400, "invalid_request", "batch is required for promote.", {
          field: "batch"
        });
      }
      return {
        kind: "json",
        status: 200,
        body: { ok: true, data: await promoteBatch(context.config, readBatchSegment(body.batch)) }
      };
    }
    case "generate": {
      readActionBody(await readJsonBody(context.request, context.maxBodyBytes));
      const report = await generateEvalDataset(context.config);
      return {
        kind: "json",
        status: 200,
        body: {
          ok: true,
          data: {
            ...report,
            dataset: { ...report.dataset, cases: report.dataset.cases.length }
          }
        }
      };
    }
    case "mine": {
      const body = readMineBody(
        await readJsonBody(context.request, context.maxBodyBytes)
      );
      return {
        kind: "json",
        status: 200,
        body: {
          ok: true,
          data: await mineCandidates(context.config, {
            batch: readBatchSegment(body.batch),
            candidates: body.candidates
          })
        }
      };
    }
    default:
      return undefined;
  }
}

/**
 * 选择批次或作者集校验，避免把校验逻辑复制到 server。
 *
 * @param context 请求上下文。
 * @param body 已验证的动作输入。
 * @returns 核心校验结果。
 */
async function validateAction(
  context: RequestContext,
  body: {
    batch?: string;
    id?: string;
    scope?: "batch" | "draft" | "golden";
  }
): Promise<unknown> {
  if (body.scope === "draft") {
    return validateDraftDraft(
      context.config,
      readBatchSegment(body.batch as string),
      readDraftSegment(body.id as string)
    );
  }
  if (body.batch) {
    return validateDraftBatch(context.config, readBatchSegment(body.batch));
  }
  if (body.scope === "batch") {
    throw new HttpError(400, "invalid_request", "batch is required when scope is batch.", {
      field: "batch"
    });
  }
  return { validation: await validateGolden(context.config) };
}
