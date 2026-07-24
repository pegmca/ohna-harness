import type { IdentityService, UserId } from "@aiagent/identity";
import {
  concurrencyGuard,
  contentSanitizer,
  errorHandler,
  messageFilter,
  QQBot,
  rateLimiter,
  type QQBotInboundMessage
} from "@tencent-connect/qqbot-nodejs";

export type ChannelStatus = "disabled" | "starting" | "connected" | "reconnecting" | "failed" | "stopped";

export interface QqBotChannelOptions {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  identityService: IdentityService;
  answerAgent: (userId: UserId, message: string) => Promise<string>;
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface QqBotChannel {
  start(): Promise<void>;
  stop(): void;
  getStatus(): ChannelStatus;
}

/**
 * 创建统一 QQ Bot 渠道。渠道只负责消息适配，身份与 Agent 决策仍由各自 package 完成。
 *
 * @param options QQ 凭据、身份服务与 Agent 回调。
 * @returns 可由 API 进程管理生命周期的 QQ channel。
 */
export function createQqBotChannel(options: QqBotChannelOptions): QqBotChannel {
  if (!options.enabled) {
    return { async start() {}, stop() {}, getStatus: () => "disabled" };
  }
  if (!options.appId || !options.appSecret) throw new Error("QQBOT_APP_ID and QQBOT_APP_SECRET are required when QQBOT_ENABLED=true.");

  const appId = options.appId;
  const log = options.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
  let status: ChannelStatus = "stopped";
  const bot = new QQBot({
    appId,
    appSecret: options.appSecret,
    accountId: appId,
    logger: {
      info: (message, meta) => log.info(message, meta),
      warn: (message, meta) => log.warn?.(message, meta),
      error: (message, meta) => log.error(message, meta)
    }
  });

  bot.use(errorHandler({ format: () => "QQ Agent 暂时不可用，请稍后重试。" }));
  bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 30_000 } }));
  bot.use(contentSanitizer({ stripBotMention: true }));
  bot.use(rateLimiter({
    perSender: { max: 12, windowMs: 60_000 },
    global: { max: 120, windowMs: 60_000 }
  }));
  bot.use(concurrencyGuard({ strategy: "queue", maxQueue: 3, maxProcessingMs: 60_000 }));

  bot.on("ready", () => { status = "connected"; });
  bot.on("resumed", () => { status = "connected"; });
  bot.on("error", (error) => {
    status = "reconnecting";
    log.error("QQ Bot connection error.", { error: error.message });
  });
  bot.on("message", async (_context, message) => {
    await handleQqMessage(bot, appId, message, options);
  });

  return {
    async start() {
      status = "starting";
      try {
        await bot.start();
        if (status === "starting") status = "connected";
      } catch (error) {
        status = "failed";
        log.error("QQ Bot failed to start.", { error: error instanceof Error ? error.message : "unknown" });
        throw error;
      }
    },
    stop() {
      bot.stop();
      status = "stopped";
    },
    getStatus() { return status; }
  };
}

/**
 * 处理私聊文本、绑定命令和 Agent 问答，并以平台 message id 保证幂等。
 *
 * @param bot QQ SDK facade。
 * @param botAccountId 当前 bot id。
 * @param message 标准化 QQ 入站消息。
 * @param options 渠道依赖。
 * @returns 消息处理完成 Promise。
 */
async function handleQqMessage(
  bot: QQBot,
  botAccountId: string,
  message: QQBotInboundMessage,
  options: QqBotChannelOptions
): Promise<void> {
  if (message.kind !== "c2c") return;
  if (message.attachments?.length && !message.content.trim()) {
    await bot.sendText(message.replyTarget, "当前仅支持私聊文本问答。");
    return;
  }

  const identity = await options.identityService.repository.getQqIdentity(botAccountId, message.senderId);
  const claimed = await options.identityService.repository.claimQqMessage(
    botAccountId,
    message.messageId,
    identity?.userId,
    new Date().toISOString()
  );
  if (!claimed) return;

  try {
    const text = message.content.trim();
    const bindMatch = /^\/bind\s+(\d{6})$/i.exec(text);
    if (bindMatch) {
      const result = await options.identityService.consumeQqBinding(bindMatch[1] ?? "", botAccountId, message.senderId);
      const response = result.status === "bound" || result.status === "already_bound"
        ? `绑定成功。你的 userId 是 ${result.identity.userId}。`
        : result.status === "conflict"
          ? "该 QQ 已绑定其他 userId，请先在原身份或 QQ 中解除绑定。"
          : result.status === "expired"
            ? "绑定码已过期，请在 Web 设置页重新生成。"
            : "绑定码无效或已使用，请检查后重试。";
      await bot.sendText(message.replyTarget, response);
      await complete("succeeded");
      return;
    }

    if (/^\/status$/i.test(text)) {
      await bot.sendText(message.replyTarget, identity ? `已绑定 userId：${identity.userId}` : "当前 QQ 尚未绑定，请在 Web 设置页获取绑定码。");
      await complete("succeeded");
      return;
    }

    if (/^\/unbind$/i.test(text)) {
      if (!identity) {
        await bot.sendText(message.replyTarget, "当前 QQ 尚未绑定。");
      } else {
        const challenge = await options.identityService.createQqUnbindChallenge(identity.userId);
        await bot.sendText(message.replyTarget, `请在 5 分钟内发送 /unbind ${challenge.code} 确认解绑。`);
      }
      await complete("succeeded");
      return;
    }

    const unbindMatch = /^\/unbind\s+(\d{6})$/i.exec(text);
    if (unbindMatch) {
      const unbound = await options.identityService.consumeQqUnbind(unbindMatch[1] ?? "", botAccountId, message.senderId);
      await bot.sendText(message.replyTarget, unbound ? "QQ 绑定已解除。" : "确认码无效或已过期。");
      await complete("succeeded");
      return;
    }

    if (!identity) {
      await bot.sendText(message.replyTarget, "请先在 Immersive Web 设置页生成绑定码，然后发送 /bind 绑定码。");
      await complete("succeeded");
      return;
    }

    if (!text) {
      await bot.sendText(message.replyTarget, "请输入有效的研究问题。");
      await complete("succeeded");
      return;
    }
    const answer = await options.answerAgent(identity.userId, text);
    await bot.sendText(message.replyTarget, answer);
    await complete("succeeded");
  } catch (error) {
    await complete("failed", "qq_message_failed");
    throw error;
  }

  async function complete(result: "succeeded" | "failed", errorCode?: string): Promise<void> {
    await options.identityService.repository.completeQqMessage(
      botAccountId,
      message.messageId,
      result,
      new Date().toISOString(),
      errorCode
    );
  }
}
