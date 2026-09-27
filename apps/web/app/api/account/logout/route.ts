import { NextResponse, type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import { clearSessionCookie, sessionIdFromRequest } from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (sessionId) await gateway.auth.logout(sessionId);
  const response = new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "private, no-store" },
  });
  clearSessionCookie(response, gateway.config);
  return response;
}
