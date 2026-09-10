import { cookies } from "next/headers";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getPeGatewayRuntime } from "./pe-gateway/runtime";
import { isPeMultiUserMode } from "./pe-multi-user-paths";
import type { RpcSessionStartOptions } from "./rpc-manager";
import type { PePlatformRuntime } from "./pe-gateway/model-service";
import type { PeBackendUser } from "./pe-gateway/backend-client";

interface PublicPlatformModel {
  id: string;
  display_name?: string;
  max_output_tokens: number;
  context_window: number;
  input_price_cny_per_million: number;
  output_price_cny_per_million: number;
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

function publicModels(models: unknown[]): PublicPlatformModel[] {
  return models.flatMap((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return [];
    const value = model as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id.trim()) return [];
    const id = value.id.trim();
    return [{
      id,
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
  const user = await gateway.auth.currentUser(sessionId);
  const session = await gateway.auth.requireSession(sessionId);
  if (!user || !session) return null;
  return { gateway, session, user };
}

export async function getPePlatformRuntimeForRequest(): Promise<PePlatformRuntime | null> {
  const context = await authenticatedPeContextForRequest();
  if (!context) return null;
  return context.gateway.models.platformRuntime(context.session, context.user);
}

export function platformRpcOptions(
  userName: string,
  platform: PePlatformRuntime | null,
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
      reasoning: false,
      input: ["text"],
      // Pi's cost unit is deliberately currency-agnostic. Platform model
      // prices are CNY per million tokens and the web UI labels them as CNY.
      // The backend currently bills all prompt tokens at the input rate, so
      // cache reads/writes use that same rate to keep the local transcript
      // estimate consistent with the server charge.
      cost: {
        input: model.input_price_cny_per_million,
        output: model.output_price_cny_per_million,
        cacheRead: model.input_price_cny_per_million,
        cacheWrite: model.input_price_cny_per_million,
      },
      contextWindow: model.context_window,
      maxTokens: model.max_output_tokens,
    })),
  };

  return {
    userName,
    initialModel: { provider: "pe-platform", modelId: platform.selectedModel },
    platformProvider,
    persistInitialModel: false,
  };
}

export async function getPePlatformRpcOptions(): Promise<RpcSessionStartOptions> {
  const context = await authenticatedPeContextForRequest();
  if (!context) return {};
  const userName = context.user.nickName?.trim()
    || context.user.email.split("@", 1)[0]?.trim()
    || "用户";
  const platform = await context.gateway.models.platformRuntime(context.session, context.user);
  return platformRpcOptions(userName, platform);
}
