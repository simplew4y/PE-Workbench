import { cookies } from "next/headers";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ModelCost, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getPeGatewayRuntime } from "./pe-gateway/runtime";
import { isPeMultiUserMode } from "./pe-multi-user-paths";
import type { RpcSessionStartOptions } from "./rpc-manager";
import type { PePlatformRuntime } from "./pe-gateway/model-service";
import type { PeBackendUser } from "./pe-gateway/backend-client";
import { localAccountContext } from "./pe-gateway/local-context";

interface PublicPlatformModel {
  id: string;
  display_name?: string;
  max_output_tokens: number;
  context_window: number;
  input_price_cny_per_million: number;
  output_price_cny_per_million: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  thinkingLevelMap: ThinkingLevelMap;
  compat: OpenAICompletionsCompat;
  cost?: ModelCost;
  thinkingCost?: ModelCost;
  thinkingMaxTokens?: number;
  maxInputTokens?: number;
  thinkingMaxInputTokens?: number;
}

function numericField(value: unknown, field: string, modelId: string, minimum: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Platform model "${modelId}" has invalid ${field}`);
  }
  return parsed;
}

export function publicModels(models: unknown[]): PublicPlatformModel[] {
  return models.flatMap((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return [];
    const value = model as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id.trim()) return [];
    const id = value.id.trim();
    const thinkingLevelMap: ThinkingLevelMap = {};
    if (value.thinking_level_map && typeof value.thinking_level_map === "object") {
      const mapping = value.thinking_level_map as Record<string, unknown>;
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        const mapped = mapping[level];
        if (mapped === null || typeof mapped === "string") thinkingLevelMap[level] = mapped;
      }
    }
    const rawCompat = value.compat && typeof value.compat === "object" ? value.compat as Record<string, unknown> : {};
    const compat: OpenAICompletionsCompat = { maxTokensField: "max_tokens", supportsStore: false };
    if (rawCompat.thinkingFormat === "qwen" || rawCompat.thinkingFormat === "deepseek" || rawCompat.thinkingFormat === "openai") {
      compat.thinkingFormat = rawCompat.thinkingFormat;
    }
    for (const key of ["supportsReasoningEffort", "supportsDeveloperRole", "supportsStrictMode", "supportsUsageInStreaming", "requiresReasoningContentOnAssistantMessages"] as const) {
      if (typeof rawCompat[key] === "boolean") compat[key] = rawCompat[key];
    }
    const parseRates = (raw: unknown) => {
      if (!raw || typeof raw !== "object") throw new Error(`Invalid platform cost for ${id}`);
      const rates = raw as Record<string, unknown>;
      return { input: numericField(rates.input, "cost.input", id, 0), output: numericField(rates.output, "cost.output", id, 0),
        cacheRead: numericField(rates.cacheRead, "cost.cacheRead", id, 0), cacheWrite: numericField(rates.cacheWrite, "cost.cacheWrite", id, 0) };
    };
    let cost: ModelCost | undefined;
    if (value.cost) {
      cost = parseRates(value.cost);
      const tiers = (value.cost as Record<string, unknown>).tiers;
      if (Array.isArray(tiers)) cost.tiers = tiers.map((tier) => ({ ...parseRates(tier), inputTokensAbove: numericField(tier.inputTokensAbove, "tier threshold", id, 1) }));
    }
    let thinkingCost: ModelCost | undefined;
    if (value.thinking_cost) {
      thinkingCost = parseRates(value.thinking_cost);
      const tiers = (value.thinking_cost as Record<string, unknown>).tiers;
      if (Array.isArray(tiers)) thinkingCost.tiers = tiers.map((tier) => ({ ...parseRates(tier), inputTokensAbove: numericField(tier.inputTokensAbove, "tier threshold", id, 1) }));
    }
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {};
    const optionalLimit = (key: string) => metadata[key] == null ? undefined : numericField(metadata[key], key, id, 1);
    return [{
      id,
      reasoning: value.reasoning === true,
      input: Array.isArray(value.input) && value.input.includes("image") ? ["text", "image"] : ["text"],
      thinkingLevelMap, compat, cost, thinkingCost,
      thinkingMaxTokens: optionalLimit("max_output_tokens_thinking"),
      maxInputTokens: optionalLimit("max_input_tokens"),
      thinkingMaxInputTokens: optionalLimit("reasoning_max_input_tokens"),
      ...(typeof value.display_name === "string" ? { display_name: value.display_name } : {}),
      max_output_tokens: numericField(value.max_output_tokens, "max_output_tokens", id, 1),
      context_window: numericField(value.context_window, "context_window", id, 1),
      input_price_cny_per_million: numericField(value.input_price_cny_per_million, "input price", id, 0),
      output_price_cny_per_million: numericField(value.output_price_cny_per_million, "output price", id, 0),
    }];
  });
}

async function authenticatedPeContextForRequest(): Promise<{
  gateway: ReturnType<typeof getPeGatewayRuntime>;
  session: NonNullable<Awaited<ReturnType<ReturnType<typeof getPeGatewayRuntime>["auth"]["requireSession"]>>>;
  user: PeBackendUser;
} | null> {
  if (!isPeMultiUserMode()) return null;
  const gateway = getPeGatewayRuntime();
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(gateway.config.cookie.name)?.value ?? "";
  if (!sessionId) return null;
  const context = await localAccountContext(gateway, sessionId);
  if (!context) return null;
  return { gateway, session: context.session, user: context.user };
}

export async function getPePlatformRuntimeForRequest(): Promise<PePlatformRuntime | null> {
  const context = await authenticatedPeContextForRequest();
  if (!context) return null;
  return context.gateway.models.catalogRuntime(context.session, context.user);
}

export function platformRpcOptions(
  userName: string,
  platform: PePlatformRuntime | null,
  thinking = false,
): RpcSessionStartOptions {
  if (!platform) return { userName };
  const models = publicModels(platform.models);
  if (!models.some((model) => model.id === platform.selectedModel)) {
    throw new Error("Selected platform model is unavailable");
  }

  const platformProvider: ProviderConfig = {
    name: "PE 平台模型",
    baseUrl: platform.access.gatewayBaseUrl,
    apiKey: platform.access.accessToken,
    api: "openai-completions",
    authHeader: true,
    models: models.map((model) => ({
      id: model.id,
      name: model.display_name || model.id,
      reasoning: model.reasoning,
      input: model.input,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: model.compat,
      // Pi's cost unit is deliberately currency-agnostic. Platform model
      // prices are CNY per million tokens and the web UI labels them as CNY.
      // Tiered and cached rates come from the same descriptor as billing.
      // Time-based prices are estimates here; backend settlement is final.
      cost: (thinking ? model.thinkingCost ?? model.cost : model.cost) ?? {
        input: model.input_price_cny_per_million,
        output: model.output_price_cny_per_million,
        cacheRead: model.input_price_cny_per_million,
        cacheWrite: model.input_price_cny_per_million,
      },
      contextWindow: Math.min(model.context_window, (thinking ? model.thinkingMaxInputTokens ?? model.maxInputTokens : model.maxInputTokens) ?? model.context_window),
      maxTokens: Math.min(model.max_output_tokens, (thinking ? model.thinkingMaxTokens : undefined) ?? model.max_output_tokens),
    })),
  };

  return {
    userName,
    initialModel: { provider: "pe-platform", modelId: platform.selectedModel },
    platformProvider,
    persistInitialModel: false,
  };
}

export async function getPePlatformRpcOptions(options: { metadataOnly?: boolean; thinkingLevel?: string } = {}): Promise<RpcSessionStartOptions> {
  const context = await authenticatedPeContextForRequest();
  if (!context) return {};
  const userName = context.user.nickName?.trim()
    || context.user.email.split("@", 1)[0]?.trim()
    || "用户";
  const platform = options.metadataOnly
    ? await context.gateway.models.catalogRuntime(context.session, context.user)
    : await context.gateway.models.platformRuntime(context.session, context.user);
  return platformRpcOptions(userName, platform, Boolean(options.thinkingLevel && options.thinkingLevel !== "off"));
}
