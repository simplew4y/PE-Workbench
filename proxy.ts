import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import { getPeGatewayRuntime } from "@/lib/pe-gateway/runtime";
import {
  clearSessionCookie,
  gatewayError,
  sessionIdFromRequest,
  unauthenticated,
} from "@/lib/pe-gateway/route-helpers";
import { isPeMultiUserMode } from "@/lib/pe-multi-user-paths";

const PUBLIC_PE_API_PATHS = new Set([
  "/api/health",
  "/api/runtime-mode",
]);

export function isPublicPeApiPath(pathname: string): boolean {
  return PUBLIC_PE_API_PATHS.has(pathname)
    || pathname.startsWith("/api/account/");
}

async function dispatchPeApiRequest(request: NextRequest): Promise<Response | null> {
  if (!isPeMultiUserMode() || isPublicPeApiPath(request.nextUrl.pathname)) return null;

  let gateway: ReturnType<typeof getPeGatewayRuntime>;
  try {
    gateway = getPeGatewayRuntime();
  } catch (error) {
    return gatewayError(error);
  }

  const sessionId = sessionIdFromRequest(request, gateway.config);
  if (!sessionId) return unauthenticated();

  try {
    const session = await gateway.auth.requireSession(sessionId);
    if (!session) {
      const response = unauthenticated();
      clearSessionCookie(response, gateway.config);
      return response;
    }
    const user = await gateway.auth.currentUser(sessionId);
    if (!user) {
      const response = unauthenticated();
      clearSessionCookie(response, gateway.config);
      return response;
    }
    // The authenticated desktop/local process owns the API, Agent RPC and
    // filesystem directly. Returning null lets Next.js dispatch the request to
    // the local route after the server-side account check succeeds.
    return null;
  } catch (error) {
    const response = gatewayError(error);
    if (response.status === 401 || response.status === 403) {
      clearSessionCookie(response, gateway.config);
    }
    return response;
  }
}

export async function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  if (isApiRequest) {
    const dispatched = await dispatchPeApiRequest(request);
    if (dispatched) return dispatched;
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
