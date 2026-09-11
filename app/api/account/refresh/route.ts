import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import {
  clearSessionCookie,
  gatewayError,
  noStoreJson,
  publicUser,
  sessionIdFromRequest,
  unauthenticated,
} from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (!sessionId) return unauthenticated();
  try {
    const refreshed = await gateway.auth.requireSession(sessionId, { forceRefresh: true });
    if (!refreshed) {
      const response = unauthenticated();
      clearSessionCookie(response, gateway.config);
      return response;
    }
    const user = await gateway.auth.currentUser(sessionId);
    if (!user) return unauthenticated();
    return noStoreJson({ ok: true, user: publicUser(user) });
  } catch (error) {
    const response = gatewayError(error);
    if (response.status === 401 || response.status === 403) clearSessionCookie(response, gateway.config);
    return response;
  }
}
