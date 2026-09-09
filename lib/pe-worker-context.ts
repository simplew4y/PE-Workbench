import { createHmac, timingSafeEqual } from "node:crypto";
import type { PePlatformRuntime } from "./pe-gateway/model-service.ts";
import type { ModelSource } from "./pe-gateway/session-store.ts";

export const PE_WORKER_CONTEXT_HEADER = "x-pe-worker-context";
export const PE_WORKER_CONTEXT_SIGNATURE_HEADER = "x-pe-worker-context-signature";

export interface PeWorkerRequestContext {
  userName: string;
  source: ModelSource;
  platform?: PePlatformRuntime;
}

function signature(payload: string, capability: string): string {
  return createHmac("sha256", capability).update(payload, "utf8").digest("base64url");
}

function normalizedContext(value: unknown): PeWorkerRequestContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker context must be an object");
  }
  const record = value as Record<string, unknown>;
  const userName = typeof record.userName === "string" ? record.userName.trim() : "";
  if (!userName || userName.length > 100) throw new Error("Worker context contains an invalid user name");
  if (record.source !== "platform" && record.source !== "custom") {
    throw new Error("Worker context contains an invalid model source");
  }
  if (record.source === "custom") return { userName, source: "custom" };

  const platform = record.platform;
  if (!platform || typeof platform !== "object" || Array.isArray(platform)) {
    throw new Error("Worker context is missing platform model access");
  }
  const data = platform as Record<string, unknown>;
  const access = data.access;
  if (!access || typeof access !== "object" || Array.isArray(access)) {
    throw new Error("Worker context is missing platform access credentials");
  }
  const accessData = access as Record<string, unknown>;
  const accessToken = typeof accessData.accessToken === "string" ? accessData.accessToken.trim() : "";
  const gatewayBaseUrl = typeof accessData.gatewayBaseUrl === "string" ? accessData.gatewayBaseUrl.trim() : "";
  const expiresIn = Number(accessData.expiresIn);
  const selectedModel = typeof data.selectedModel === "string" ? data.selectedModel.trim() : "";
  if (!accessToken || !gatewayBaseUrl || !selectedModel || !Array.isArray(data.models)) {
    throw new Error("Worker context contains incomplete platform model access");
  }
  const parsedUrl = new URL(gatewayBaseUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("Worker context contains an invalid platform gateway URL");
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Worker context contains an invalid platform token expiry");
  }
  return {
    userName,
    source: "platform",
    platform: {
      access: {
        accessToken,
        gatewayBaseUrl: gatewayBaseUrl.replace(/\/$/u, ""),
        expiresIn: Math.floor(expiresIn),
      },
      models: data.models,
      selectedModel,
    },
  };
}

export function createPeWorkerContextHeaders(
  context: PeWorkerRequestContext,
  capability: string,
): Record<string, string> {
  if (capability.trim().length < 32) throw new Error("Worker capability is too short");
  const normalized = normalizedContext(context);
  const payload = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  if (payload.length > 48 * 1024) throw new Error("Worker context is too large");
  return {
    [PE_WORKER_CONTEXT_HEADER]: payload,
    [PE_WORKER_CONTEXT_SIGNATURE_HEADER]: signature(payload, capability),
  };
}

export function readPeWorkerContext(
  requestHeaders: Pick<Headers, "get">,
  capability: string,
): PeWorkerRequestContext {
  if (capability.trim().length < 32) throw new Error("Worker capability is not configured");
  const payload = requestHeaders.get(PE_WORKER_CONTEXT_HEADER)?.trim() ?? "";
  const suppliedSignature = requestHeaders.get(PE_WORKER_CONTEXT_SIGNATURE_HEADER)?.trim() ?? "";
  if (!payload || !suppliedSignature || payload.length > 48 * 1024) {
    throw new Error("Worker request context is missing");
  }
  const expectedSignature = signature(payload, capability);
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(
    Buffer.from(suppliedSignature),
    Buffer.from(expectedSignature),
  )) {
    throw new Error("Worker request context signature is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Worker request context is invalid");
  }
  return normalizedContext(decoded);
}
