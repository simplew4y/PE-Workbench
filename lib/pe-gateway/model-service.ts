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
import { isCloudUnavailable } from "./local-context.ts";
import { isPeDesktopMode } from "../pe-desktop-mode.ts";

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
    let platform: PePlatformModels;
    try {
      if (user.status === "offline") throw new PeModelServiceError(503, "backend_unavailable", "用户服务未连接");
      platform = await this.backend.models(session.accessToken);
      if (platform.available) this.store.setPlatformCatalog(user.id, platform);
    } catch (error) {
      if (user.status !== "offline" && !(isPeDesktopMode() && isCloudUnavailable(error))) throw error;
      const cached = this.store.getPlatformCatalog(user.id) as PePlatformModels | null;
      return {
        source,
        platform: { available: false, models: Array.isArray(cached?.models) ? cached.models : [], defaultModel: cached?.defaultModel ?? null, selectedModel: this.store.getPlatformModel(user.id),
          balanceCny: "unknown", error: "用户服务未连接，平台模型暂不可用；可切换到自定义模型" },
        custom: { configured: this.customModelConfigured() },
      };
    }
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

  async catalogRuntime(session: GatewaySession, user: PeBackendUser): Promise<PePlatformRuntime | null> {
    if (this.sourceForUser(user.id) === "custom") return null;
    const state = await this.state(session, user);
    if (!state.platform.selectedModel || !platformModelIds(state.platform).includes(state.platform.selectedModel)) return null;
    return {
      models: state.platform.models, selectedModel: state.platform.selectedModel,
      // Metadata-only registration must NEVER carry a usable model token.
      access: { accessToken: "metadata-only-no-cloud-authorization", expiresIn: 0, gatewayBaseUrl: "https://platform.invalid/v1" },
    };
  }

  async platformRuntime(session: GatewaySession, user: PeBackendUser, proposed?: PeModelServiceState): Promise<PePlatformRuntime | null> {
    // Model sources are an explicit security and billing boundary. A custom
    // selection must never request a platform token or silently fall back.
    if ((proposed?.source ?? this.sourceForUser(user.id)) === "custom") return null;
    const state = proposed ?? await this.state(session, user);
    const balance = Number(state.platform.balanceCny);
    if (Number.isFinite(balance) && balance <= 0) {
      throw new PeModelServiceError(
        402,
        "insufficient_balance",
        "平台余额不足，请充值或切换到自定义模型",
      );
    }
    if (!state.platform.available || !state.platform.selectedModel) {
      throw new PeModelServiceError(503, "platform_models_unavailable", state.platform.error || "No platform model is available");
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
