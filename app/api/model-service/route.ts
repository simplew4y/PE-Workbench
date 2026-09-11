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
import { getRpcSession, startRpcSession, ModelSelectionError } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { platformRpcOptions } from "@/lib/pe-platform-runtime";
import { PeModelServiceError } from "@/lib/pe-gateway/model-service";

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
    const proposed = { ...current, source: body.source as ModelSource, platform: { ...current.platform } };
    if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || !body.sessionId.trim())) {
      throw new PeRequestError(400, "invalid_session_id", "会话 ID 无效");
    }
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
      if (!current.platform.models.some((item) => item && typeof item === "object" && "id" in item && item.id === requestedModel)) {
        throw new PeRequestError(400, "invalid_platform_model", "所选平台模型不存在或已停用");
      }
      proposed.platform.selectedModel = requestedModel;
    }
    const commit = () => {
      if (proposed.source === "platform" && proposed.platform.selectedModel) {
        context.gateway.models.setPlatformModel(context.user!.id, proposed.platform.selectedModel, current.platform);
      }
      context.gateway.models.setSource(context.user!.id, proposed.source);
    };
    let appliedModel: { provider: string; modelId: string } | null = null;
    if (typeof body.sessionId === "string") {
      let agent = getRpcSession(body.sessionId);
      if (agent?.isRunning()) throw new ModelSelectionError("当前会话正在运行，请等待回复或压缩完成后再切换模型");
      const path = agent?.isAlive() ? null : await resolveSessionPath(body.sessionId);
      if (!agent?.isAlive() && !path) throw new PeRequestError(404, "session_not_found", "会话不存在");
      const platform = await context.gateway.models.platformRuntime(context.session!, context.user!, proposed);
      const userName = context.user!.nickName?.trim() || context.user!.email.split("@", 1)[0] || "用户";
      const options = platformRpcOptions(userName, platform);
      if (!agent?.isAlive()) agent = (await startRpcSession(body.sessionId, path!, undefined, options)).session;
      appliedModel = await agent.applyModelSource(options, commit);
    } else {
      commit();
    }
    return noStoreJson({ ...publicState(proposed), applied_model: appliedModel, session_id: body.sessionId ?? null });
  } catch (error) {
    if (error instanceof ModelSelectionError || error instanceof PeModelServiceError) {
      return noStoreJson({ code: error.code, message: error.message }, { status: error.status });
    }
    return gatewayError(error);
  }
}
