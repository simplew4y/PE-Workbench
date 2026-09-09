import { cookies } from "next/headers";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getPeGatewayRuntime } from "./pe-gateway/runtime";
import { isPeMultiUserMode } from "./pe-multi-user-paths";
import type { RpcSessionStartOptions } from "./rpc-manager";
import type { PePlatformRuntime } from "./pe-gateway/model-service";
import type { PeBackendUser } from "./pe-gateway/backend-client";

interface PublicPlatformModel {
  id: string;
  display_name?: string;
  max_output_tokens?: number;
  context_window?: number;
}

function publicModels(models: unknown[]): PublicPlatformModel[] {
  return models.flatMap((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return [];
    const value = model as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id.trim()) return [];
    return [{
      id: value.id.trim(),
      ...(typeof value.display_name === "string" ? { display_name: value.display_name } : {}),
      ...(typeof value.max_output_tokens === "number" ? { max_output_tokens: value.max_output_tokens } : {}),
      ...(typeof value.context_window === "number" ? { context_window: value.context_window } : {}),
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

function platformRpcOptions(
  userName: string,
  platform: PePlatformRuntime | null,
): RpcSessionStartOptions {
  if (!platform) return { userName };
  const models = publicModels(platform.models);
  if (!models.some((model) => model.id === platform.selectedModel)) {
    throw new Error("Selected platform model is unavailable");
  }

  const registerPlatformProvider: ExtensionFactory = (pi) => {
    pi.registerProvider("pe-platform", {
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.context_window ?? 128_000,
        maxTokens: model.max_output_tokens ?? 16_384,
      })),
    });
  };

  return {
    userName,
    initialModel: { provider: "pe-platform", modelId: platform.selectedModel },
    extensionFactories: [registerPlatformProvider],
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
