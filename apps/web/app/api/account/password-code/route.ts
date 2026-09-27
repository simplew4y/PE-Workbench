import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import {
  clearSessionCookie,
  gatewayError,
  noStoreJson,
  sessionIdFromRequest,
  unauthenticated,
} from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (!sessionId) return unauthenticated();
  try {
    if (!await gateway.auth.sendChangePasswordCode(sessionId)) {
      const response = unauthenticated();
      clearSessionCookie(response, gateway.config);
      return response;
    }
    return noStoreJson({ accepted: true });
  } catch (error) {
    const response = gatewayError(error);
    if (response.status === 401 || response.status === 403) clearSessionCookie(response, gateway.config);
    return response;
  }
}
