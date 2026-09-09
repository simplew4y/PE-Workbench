import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import {
  clearSessionCookie,
  gatewayError,
  noStoreJson,
  PeRequestError,
  readJsonObject,
  sessionIdFromRequest,
  unauthenticated,
} from "@/lib/pe-gateway/route-helpers";
import type { ModelSource } from "@/lib/pe-gateway/session-store";

export const runtime = "nodejs";

function publicState(state: Awaited<ReturnType<ReturnType<typeof getPeGatewayRuntime>["models"]["state"]>>) {
  return {
    source: state.source,
    platform: {
      available: state.platform.available,
      balance_cny: state.platform.balanceCny,
      models: state.platform.models,
      default_model: state.platform.defaultModel,
      selected_model: state.platform.selectedModel,
      error: state.platform.error,
    },
    custom: state.custom,
  };
}

async function authenticatedState(request: NextRequest) {
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (!sessionId) return { gateway, response: unauthenticated() };
  const user = await gateway.auth.currentUser(sessionId);
  const session = await gateway.auth.requireSession(sessionId);
  if (!user || !session) {
    const response = unauthenticated();
    clearSessionCookie(response, gateway.config);
    return { gateway, response };
  }
  return { gateway, user, session, sessionId };
}

export async function GET(request: NextRequest) {
  try {
    const context = await authenticatedState(request);
    if (context.response) return context.response;
    return noStoreJson(publicState(await context.gateway.models.state(context.session!, context.user!)));
  } catch (error) {
    return gatewayError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    if (body.source !== "platform" && body.source !== "custom") {
      return noStoreJson(
        { code: "invalid_model_source", message: "模型来源必须为 platform 或 custom" },
        { status: 400 },
      );
    }
    const context = await authenticatedState(request);
    if (context.response) return context.response;
    const current = await context.gateway.models.state(context.session!, context.user!);
    if (body.source === "platform") {
      if (!current.platform.available) {
        throw new PeRequestError(
          409,
          "platform_models_unavailable",
          current.platform.error || "平台模型暂不可用",
        );
      }
      const requestedModel = typeof body.model === "string"
        ? body.model.trim()
        : current.platform.selectedModel;
      if (!requestedModel) {
        throw new PeRequestError(409, "platform_models_empty", "管理员尚未开放平台模型");
      }
      try {
        context.gateway.models.setPlatformModel(context.user!.id, requestedModel, current.platform);
      } catch {
        throw new PeRequestError(400, "invalid_platform_model", "所选平台模型不存在或已停用");
      }
    }
    context.gateway.models.setSource(context.user!.id, body.source as ModelSource);
    return noStoreJson(publicState(await context.gateway.models.state(context.session!, context.user!)));
  } catch (error) {
    return gatewayError(error);
  }
}
