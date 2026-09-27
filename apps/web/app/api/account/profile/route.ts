import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import {
  clearSessionCookie,
  gatewayError,
  noStoreJson,
  publicUser,
  readJsonObject,
  sessionIdFromRequest,
  unauthenticated,
  PeRequestError,
} from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (!sessionId) return unauthenticated();
  try {
    const body = await readJsonObject(request);
    if (body.nick_name !== null && typeof body.nick_name !== "string") {
      throw new PeRequestError(400, "invalid_nick_name", "昵称格式不正确");
    }
    const nickName = typeof body.nick_name === "string" ? body.nick_name.trim() || null : null;
    if (nickName && nickName.length > 120) {
      throw new PeRequestError(400, "invalid_nick_name", "昵称不能超过 120 个字符");
    }
    const user = await gateway.auth.updateProfile(sessionId, nickName);
    if (!user) {
      const response = unauthenticated();
      clearSessionCookie(response, gateway.config);
      return response;
    }
    return noStoreJson({ user: publicUser(user) });
  } catch (error) {
    const response = gatewayError(error);
    if (response.status === 401 || response.status === 403) clearSessionCookie(response, gateway.config);
    return response;
  }
}
