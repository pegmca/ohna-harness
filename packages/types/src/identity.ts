import type { ISODateTimeString, UserId } from "./primitives.js";

export interface QqIdentityDto {
  botAccountId: string;
  boundAt: ISODateTimeString;
}

export interface IdentityMeDto {
  userId: UserId;
  createdAt: ISODateTimeString;
  qqIdentity?: QqIdentityDto;
  qqBot: {
    enabled: boolean;
    status: "disabled" | "starting" | "connected" | "reconnecting" | "failed" | "stopped";
  };
}

export interface IdentityBootstrapRequestDto {
  visitorId: string;
  fingerprintVersion: string;
}

export interface QqBindingChallengeDto {
  challengeId: string;
  code: string;
  command: string;
  expiresAt: ISODateTimeString;
  botQrUrl?: string;
}

export interface QqBindingStatusDto {
  challengeId: string;
  status: "pending" | "bound" | "expired" | "failed";
  qqIdentity?: QqIdentityDto;
}
