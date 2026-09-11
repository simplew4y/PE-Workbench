import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import { gatewayError, noStoreJson, readJsonObject } from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return noStoreJson({ code: "missing_email", message: "请输入邮箱" }, { status: 400 });
    await getPeGatewayRuntime().auth.sendVerificationCode(email);
    return noStoreJson({ status: "accepted" }, { status: 202 });
  } catch (error) {
    return gatewayError(error);
  }
}
