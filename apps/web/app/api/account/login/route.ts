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
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return noStoreJson({ code: "missing_credentials", message: "请输入邮箱和密码" }, { status: 400 });
    }
    const gateway = getPeGatewayRuntime();
    const authenticated = await gateway.auth.login(email, password);
    const response = noStoreJson({ user: publicUser(authenticated.user!) });
    setSessionCookie(response, authenticated.sessionId, gateway.config);
    return response;
  } catch (error) {
    return gatewayError(error);
  }
}
