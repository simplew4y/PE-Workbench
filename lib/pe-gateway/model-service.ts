import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  PeBackendClient,
  PeBackendUser,
  PePlatformAccessToken,
  PePlatformModels,
} from "./backend-client.ts";
import type { GatewaySession, ModelSource, PeGatewaySessionStore } from "./session-store.ts";

export interface PeModelServiceState {
  source: ModelSource;
  platform: PePlatformModels & { balanceCny: string; selectedModel: string | null };
  custom: { configured: boolean | null };
}

export interface PePlatformRuntime {
  access: PePlatformAccessToken;
  models: unknown[];
  selectedModel: string;
}

export class PeModelServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PeModelServiceError";
  }
}

function platformModelIds(platform: PePlatformModels): string[] {
  return platform.models.flatMap((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return [];
    const id = (model as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function hasConfiguredCustomModel(): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
    return typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

export class PeGatewayModelService {
  private readonly accessTokens = new Map<string, { value: PePlatformAccessToken; expiresAt: number }>();

  constructor(
    private readonly backend: Pick<PeBackendClient, "models" | "modelAccessToken">,
    private readonly store: PeGatewaySessionStore,
    private readonly customModelConfigured: () => boolean = hasConfiguredCustomModel,
  ) {}

  sourceForUser(userId: string): ModelSource {
    const existing = this.store.getModelSource(userId);
    if (existing) return existing;
    this.store.setModelSource(userId, "platform");
    return "platform";
  }

  setSource(userId: string, source: ModelSource): ModelSource {
    this.store.setModelSource(userId, source);
    return source;
  }

  setPlatformModel(userId: string, modelId: string, platform: PePlatformModels): string {
    const normalized = modelId.trim();
    if (!platformModelIds(platform).includes(normalized)) throw new Error("Platform model is unavailable");
    this.store.setPlatformModel(userId, normalized);
    return normalized;
  }

  async state(session: GatewaySession, user: PeBackendUser): Promise<PeModelServiceState> {
    const source = this.sourceForUser(user.id);
    const platform = await this.backend.models(session.accessToken);
    const modelIds = platformModelIds(platform);
    const storedModel = this.store.getPlatformModel(user.id);
    const selectedModel = storedModel && modelIds.includes(storedModel)
      ? storedModel
      : platform.defaultModel && modelIds.includes(platform.defaultModel)
        ? platform.defaultModel
        : modelIds[0] ?? null;
    if (selectedModel && selectedModel !== storedModel) {
      this.store.setPlatformModel(user.id, selectedModel);
    }
    return {
      source,
      platform: { ...platform, balanceCny: user.balanceCny, selectedModel },
      custom: { configured: this.customModelConfigured() },
    };
  }

  async platformRuntime(session: GatewaySession, user: PeBackendUser): Promise<PePlatformRuntime | null> {
    // Model sources are an explicit security and billing boundary. A custom
    // selection must never request a platform token or silently fall back.
    if (this.sourceForUser(user.id) === "custom") return null;
    const state = await this.state(session, user);
    const balance = Number(state.platform.balanceCny);
    if (Number.isFinite(balance) && balance <= 0) {
      throw new PeModelServiceError(
        402,
        "insufficient_balance",
        "平台余额不足，请充值或切换到自定义模型",
      );
    }
    if (!state.platform.available || !state.platform.selectedModel) {
      throw new Error(state.platform.error || "No platform model is available");
    }
    const now = Math.floor(Date.now() / 1000);
    let cached = this.accessTokens.get(user.id);
    if (!cached || cached.expiresAt <= now + 60) {
      const value = await this.backend.modelAccessToken(session.accessToken);
      cached = { value, expiresAt: now + value.expiresIn };
      this.accessTokens.set(user.id, cached);
    }
    return {
      access: cached.value,
      models: state.platform.models,
      selectedModel: state.platform.selectedModel,
    };
  }
}
