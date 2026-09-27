import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import { gatewayError, noStoreJson, readJsonObject } from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    if (!email || !/^\d{6}$/u.test(code) || newPassword.length < 8 || newPassword.length > 1024) {
      return noStoreJson(
        { code: "invalid_password_reset", message: "请输入有效邮箱、6 位验证码和 8 至 1024 位新密码" },
        { status: 400 },
      );
    }
    await getPeGatewayRuntime().auth.resetPassword(email, code, newPassword);
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return gatewayError(error);
  }
}
