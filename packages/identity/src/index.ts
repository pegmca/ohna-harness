import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export type UserId = string;
export type IdentityChallengePurpose = "bind_qq" | "unbind_qq";
export type IdentityChallengeStatus = "pending" | "bound" | "expired" | "failed";

export interface IdentityUser {
  userId: UserId;
  createdAt: string;
  lastSeenAt: string;
}

export interface QqIdentity {
  userId: UserId;
  botAccountId: string;
  qqOpenId: string;
  boundAt: string;
}

export interface IdentitySnapshot {
  userId: UserId;
  createdAt: string;
  qqIdentity?: QqIdentity;
}

export interface IdentitySession {
  userId: UserId;
  expiresAt: string;
  revokedAt?: string;
}

export interface IdentityChallenge {
  challengeId: string;
  userId: UserId;
  purpose: IdentityChallengePurpose;
  codeDigest: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
  consumedAt?: string;
  failedAt?: string;
}

export type ConsumeQqBindingResult =
  | { status: "bound"; identity: QqIdentity }
  | { status: "already_bound"; identity: QqIdentity }
  | { status: "not_found" | "expired" | "failed" | "conflict" };

export interface IdentityRepository {
  findOrCreateUserByFingerprint(fingerprintDigest: string, fingerprintVersion: string, now: string): Promise<IdentityUser>;
  createSession(userId: UserId, tokenDigest: string, expiresAt: string, now: string): Promise<void>;
  findSession(tokenDigest: string, now: string): Promise<IdentitySession | undefined>;
  getUser(userId: UserId): Promise<IdentityUser | undefined>;
  getQqIdentityByUserId(userId: UserId): Promise<QqIdentity | undefined>;
  getQqIdentity(botAccountId: string, qqOpenId: string): Promise<QqIdentity | undefined>;
  createChallenge(input: IdentityChallenge): Promise<void>;
  getChallenge(challengeId: string, userId: UserId): Promise<IdentityChallenge | undefined>;
  consumeQqBinding(codeDigest: string, botAccountId: string, qqOpenId: string, now: string): Promise<ConsumeQqBindingResult>;
  unbindQqByUserId(userId: UserId, now: string): Promise<boolean>;
  consumeQqUnbind(codeDigest: string, botAccountId: string, qqOpenId: string, now: string): Promise<boolean>;
  claimQqMessage(botAccountId: string, platformMessageId: string, userId: UserId | undefined, now: string): Promise<boolean>;
  completeQqMessage(botAccountId: string, platformMessageId: string, status: "succeeded" | "failed", now: string, errorCode?: string): Promise<void>;
}

export interface IdentityServiceOptions {
  fingerprintPepper: string;
  sessionTtlDays?: number;
  bindTtlMinutes?: number;
}

export interface CreatedIdentitySession {
  token: string;
  snapshot: IdentitySnapshot;
  expiresAt: string;
}

export interface CreatedBindingChallenge {
  challengeId: string;
  code: string;
  expiresAt: string;
}

/**
 * 创建身份应用服务，把指纹摘要、session 和 QQ challenge 的规则集中在稳定边界内。
 *
 * @param repository 身份持久化端口。
 * @param options 指纹 pepper 与有效期配置。
 * @returns 可供 HTTP 和 QQ adapter 复用的身份服务。
 */
export function createIdentityService(repository: IdentityRepository, options: IdentityServiceOptions) {
  if (!options.fingerprintPepper.trim()) throw new Error("IDENTITY_FINGERPRINT_PEPPER is required.");
  const sessionTtlDays = options.sessionTtlDays ?? 30;
  const bindTtlMinutes = options.bindTtlMinutes ?? 10;

  return {
    /**
     * 根据浏览器指纹查找或创建用户，并签发不透明 session。
     *
     * @param visitorId FingerprintJS 生成的 visitor id。
     * @param fingerprintVersion 指纹算法版本。
     * @returns 新 session 与当前身份快照。
     */
    async bootstrap(visitorId: string, fingerprintVersion: string): Promise<CreatedIdentitySession> {
      const now = new Date();
      const nowIso = now.toISOString();
      const digest = createHmac("sha256", options.fingerprintPepper).update(visitorId).digest("hex");
      const user = await repository.findOrCreateUserByFingerprint(digest, fingerprintVersion, nowIso);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now.getTime() + sessionTtlDays * 86_400_000).toISOString();
      await repository.createSession(user.userId, digestToken(token), expiresAt, nowIso);
      return {
        token,
        expiresAt,
        snapshot: {
          userId: user.userId,
          createdAt: user.createdAt,
          qqIdentity: await repository.getQqIdentityByUserId(user.userId)
        }
      };
    },

    /**
     * 校验不透明 session token 并返回当前身份。
     *
     * @param token Cookie 中的原始 session token。
     * @returns 有效身份；无效或过期时返回 undefined。
     */
    async authenticate(token: string | undefined): Promise<IdentitySnapshot | undefined> {
      if (!token) return undefined;
      const session = await repository.findSession(digestToken(token), new Date().toISOString());
      if (!session || session.revokedAt) return undefined;
      const user = await repository.getUser(session.userId);
      if (!user) return undefined;
      return {
        userId: user.userId,
        createdAt: user.createdAt,
        qqIdentity: await repository.getQqIdentityByUserId(user.userId)
      };
    },

    /**
     * 为当前用户创建新的六位 QQ 绑定码，旧的有效码由 repository 失效。
     *
     * @param userId 当前用户 id。
     * @returns 可展示给用户的一次性明文 code。
     */
    async createQqBindingChallenge(userId: UserId): Promise<CreatedBindingChallenge> {
      const code = randomNumericCode();
      const now = new Date();
      const challenge: IdentityChallenge = {
        challengeId: randomUUID(),
        userId,
        purpose: "bind_qq",
        codeDigest: digestToken(code),
        expiresAt: new Date(now.getTime() + bindTtlMinutes * 60_000).toISOString(),
        attempts: 0,
        maxAttempts: 5
      };
      await repository.createChallenge(challenge);
      return { challengeId: challenge.challengeId, code, expiresAt: challenge.expiresAt };
    },

    /**
     * 为 QQ 内二次确认解绑创建一次性 code。
     *
     * @param userId 已绑定 QQ 的用户 id。
     * @returns QQ 内确认使用的 challenge。
     */
    async createQqUnbindChallenge(userId: UserId): Promise<CreatedBindingChallenge> {
      const code = randomNumericCode();
      const now = new Date();
      const challenge: IdentityChallenge = {
        challengeId: randomUUID(),
        userId,
        purpose: "unbind_qq",
        codeDigest: digestToken(code),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        attempts: 0,
        maxAttempts: 5
      };
      await repository.createChallenge(challenge);
      return { challengeId: challenge.challengeId, code, expiresAt: challenge.expiresAt };
    },

    /**
     * 查询 Web 轮询需要的 challenge 状态。
     *
     * @param challengeId challenge id。
     * @param userId 当前用户 id。
     * @returns challenge 状态。
     */
    async getQqBindingStatus(challengeId: string, userId: UserId): Promise<IdentityChallengeStatus> {
      const challenge = await repository.getChallenge(challengeId, userId);
      if (!challenge) return "failed";
      if (challenge.consumedAt) return "bound";
      if (challenge.failedAt || challenge.attempts >= challenge.maxAttempts) return "failed";
      if (Date.parse(challenge.expiresAt) <= Date.now()) return "expired";
      return "pending";
    },

    /**
     * 处理 QQ `/bind` 命令。
     *
     * @param code 用户从 Web 得到的六位绑定码。
     * @param botAccountId 当前 Bot AppID。
     * @param qqOpenId QQ 消息事件中的用户 OpenID。
     * @returns 绑定结果。
     */
    consumeQqBinding(code: string, botAccountId: string, qqOpenId: string): Promise<ConsumeQqBindingResult> {
      return repository.consumeQqBinding(digestToken(code), botAccountId, qqOpenId, new Date().toISOString());
    },

    /**
     * 从 Web 解除当前用户的 QQ 绑定。
     *
     * @param userId 当前用户 id。
     * @returns 是否实际删除绑定。
     */
    unbindQq(userId: UserId): Promise<boolean> {
      return repository.unbindQqByUserId(userId, new Date().toISOString());
    },

    /**
     * 处理 QQ `/unbind <code>` 二次确认。
     *
     * @param code QQ 内收到的确认码。
     * @param botAccountId 当前 bot id。
     * @param qqOpenId 当前 QQ 用户 OpenID。
     * @returns 是否解绑成功。
     */
    consumeQqUnbind(code: string, botAccountId: string, qqOpenId: string): Promise<boolean> {
      return repository.consumeQqUnbind(digestToken(code), botAccountId, qqOpenId, new Date().toISOString());
    },

    repository
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;

/**
 * 对 bearer、session 和一次性 code 做不可逆摘要。
 *
 * @param value 原始敏感值。
 * @returns SHA-256 十六进制摘要。
 */
export function digestToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 创建测试和无数据库单测使用的内存 repository；生产 server 必须注入 PostgreSQL adapter。
 *
 * @returns 遵循同一端口语义的内存实现。
 */
export function createInMemoryIdentityRepository(): IdentityRepository {
  const users = new Map<UserId, IdentityUser>();
  const usersByFingerprint = new Map<string, UserId>();
  const sessions = new Map<string, IdentitySession>();
  const qqByUser = new Map<UserId, QqIdentity>();
  const qqByExternal = new Map<string, QqIdentity>();
  const challenges = new Map<string, IdentityChallenge>();
  const receipts = new Set<string>();

  return {
    async findOrCreateUserByFingerprint(fingerprintDigest, _fingerprintVersion, now) {
      const existingId = usersByFingerprint.get(fingerprintDigest);
      if (existingId) {
        const existing = users.get(existingId);
        if (existing) {
          const touched = { ...existing, lastSeenAt: now };
          users.set(existingId, touched);
          return touched;
        }
      }
      const user: IdentityUser = { userId: randomUUID(), createdAt: now, lastSeenAt: now };
      users.set(user.userId, user);
      usersByFingerprint.set(fingerprintDigest, user.userId);
      return user;
    },
    async createSession(userId, tokenDigest, expiresAt) {
      sessions.set(tokenDigest, { userId, expiresAt });
    },
    async findSession(tokenDigest, now) {
      const session = sessions.get(tokenDigest);
      return session && Date.parse(session.expiresAt) > Date.parse(now) ? session : undefined;
    },
    async getUser(userId) { return users.get(userId); },
    async getQqIdentityByUserId(userId) { return qqByUser.get(userId); },
    async getQqIdentity(botAccountId, qqOpenId) { return qqByExternal.get(`${botAccountId}:${qqOpenId}`); },
    async createChallenge(input) {
      for (const [id, challenge] of challenges) {
        if (challenge.userId === input.userId && challenge.purpose === input.purpose && !challenge.consumedAt) {
          challenges.set(id, { ...challenge, failedAt: new Date().toISOString() });
        }
      }
      challenges.set(input.challengeId, input);
    },
    async getChallenge(challengeId, userId) {
      const challenge = challenges.get(challengeId);
      return challenge?.userId === userId ? challenge : undefined;
    },
    async consumeQqBinding(codeDigest, botAccountId, qqOpenId, now) {
      const challenge = [...challenges.values()].find((item) => item.purpose === "bind_qq" && item.codeDigest === codeDigest && !item.consumedAt);
      if (!challenge) return { status: "not_found" };
      if (challenge.failedAt || challenge.attempts >= challenge.maxAttempts) return { status: "failed" };
      if (Date.parse(challenge.expiresAt) <= Date.parse(now)) return { status: "expired" };
      const externalKey = `${botAccountId}:${qqOpenId}`;
      const external = qqByExternal.get(externalKey);
      if (external && external.userId !== challenge.userId) return { status: "conflict" };
      const current = qqByUser.get(challenge.userId);
      if (current && (current.botAccountId !== botAccountId || current.qqOpenId !== qqOpenId)) return { status: "conflict" };
      const identity = external ?? current ?? { userId: challenge.userId, botAccountId, qqOpenId, boundAt: now };
      qqByUser.set(challenge.userId, identity);
      qqByExternal.set(externalKey, identity);
      challenges.set(challenge.challengeId, { ...challenge, consumedAt: now });
      return { status: external || current ? "already_bound" : "bound", identity };
    },
    async unbindQqByUserId(userId) {
      const identity = qqByUser.get(userId);
      if (!identity) return false;
      qqByUser.delete(userId);
      qqByExternal.delete(`${identity.botAccountId}:${identity.qqOpenId}`);
      return true;
    },
    async consumeQqUnbind(codeDigest, botAccountId, qqOpenId, now) {
      const identity = qqByExternal.get(`${botAccountId}:${qqOpenId}`);
      if (!identity) return false;
      const challenge = [...challenges.values()].find((item) => item.userId === identity.userId && item.purpose === "unbind_qq" && item.codeDigest === codeDigest && !item.consumedAt && Date.parse(item.expiresAt) > Date.parse(now));
      if (!challenge) return false;
      challenges.set(challenge.challengeId, { ...challenge, consumedAt: now });
      qqByUser.delete(identity.userId);
      qqByExternal.delete(`${botAccountId}:${qqOpenId}`);
      return true;
    },
    async claimQqMessage(botAccountId, platformMessageId) {
      const key = `${botAccountId}:${platformMessageId}`;
      if (receipts.has(key)) return false;
      receipts.add(key);
      return true;
    },
    async completeQqMessage() {}
  };
}

/**
 * 生成便于在 QQ 中手输的六位数字 code。
 *
 * @returns 六位数字字符串。
 */
function randomNumericCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, "0");
}
