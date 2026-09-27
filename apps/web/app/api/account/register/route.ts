import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import {
  gatewayError,
  noStoreJson,
  publicUser,
  readJsonObject,
  setSessionCookie,
} from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const nickName = typeof body.nick_name === "string" ? body.nick_name.trim() || null : null;
    const preferredLocale = body.preferred_locale === "en-US" ? "en-US" : "zh-CN";
    if (!email || !/^\d{6}$/u.test(code) || password.length < 8) {
      return noStoreJson(
        { code: "invalid_registration", message: "请输入有效邮箱、6 位验证码和至少 8 位密码" },
        { status: 400 },
      );
    }
    const gateway = getPeGatewayRuntime();
    const authenticated = await gateway.auth.register({
      email,
      code,
      password,
      nickName,
      preferredLocale,
    });
    const response = noStoreJson({ user: publicUser(authenticated.user!) }, { status: 201 });
    setSessionCookie(response, authenticated.sessionId, gateway.config);
    return response;
  } catch (error) {
    return gatewayError(error);
  }
}
