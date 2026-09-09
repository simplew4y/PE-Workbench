import { NextResponse, type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import {
  clearSessionCookie,
  gatewayError,
  PeRequestError,
  readJsonObject,
  sessionIdFromRequest,
  unauthenticated,
} from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (!sessionId) return unauthenticated();
  try {
    const body = await readJsonObject(request);
    if (typeof body.code !== "string" || !/^\d{6}$/u.test(body.code)) {
      throw new PeRequestError(400, "invalid_verification_code", "请输入 6 位验证码");
    }
    if (typeof body.new_password !== "string" || body.new_password.length < 8 || body.new_password.length > 1024) {
      throw new PeRequestError(400, "invalid_password", "新密码长度必须为 8 至 1024 个字符");
    }
    if (!await gateway.auth.changePassword(sessionId, body.code, body.new_password)) {
      const response = unauthenticated();
      clearSessionCookie(response, gateway.config);
      return response;
    }
    const response = new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store" },
    });
    clearSessionCookie(response, gateway.config);
    return response;
  } catch (error) {
    const response = gatewayError(error);
    if (response.status === 401 || response.status === 403) clearSessionCookie(response, gateway.config);
    return response;
  }
}
