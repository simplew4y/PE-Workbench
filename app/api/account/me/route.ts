import { type NextRequest } from "next/server";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import { localAccountContext } from "@/lib/pe-gateway/local-context";
import {
  clearSessionCookie,
  gatewayError,
  noStoreJson,
  publicUser,
  sessionIdFromRequest,
  unauthenticated,
} from "@/lib/pe-gateway/route-helpers";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (!sessionId) return unauthenticated();
  try {
    const context = await localAccountContext(gateway, sessionId);
    if (!context) {
      const response = unauthenticated();
      clearSessionCookie(response, gateway.config);
      return response;
    }
    return noStoreJson({ ...publicUser(context.user), offline: context.offline });
  } catch (error) {
    const response = gatewayError(error);
    if (response.status === 401 || response.status === 403) clearSessionCookie(response, gateway.config);
    return response;
  }
}
