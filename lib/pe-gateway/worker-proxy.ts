import type { PeBackendUser } from "./backend-client.ts";
import type { PeGatewayRuntime } from "./runtime.ts";
import type { GatewaySession } from "./session-store.ts";
import type { WorkerTarget } from "./worker-orchestrator.ts";
import {
  createPeWorkerContextHeaders,
  PE_WORKER_CONTEXT_HEADER,
  PE_WORKER_CONTEXT_SIGNATURE_HEADER,
  type PeWorkerRequestContext,
} from "../pe-worker-context.ts";

const GATEWAY_API_PATHS = new Set([
  "/api/health",
  "/api/runtime-mode",
  "/api/model-service",
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-pe-worker-capability",
  PE_WORKER_CONTEXT_HEADER,
  PE_WORKER_CONTEXT_SIGNATURE_HEADER,
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function isGatewayOwnedApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/account/") || GATEWAY_API_PATHS.has(pathname);
}

export function isPeProxyRequestAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown; constructor?: { name?: unknown } };
  const names = [String(record.name ?? ""), String(record.constructor?.name ?? "")];
  return names.includes("AbortError")
    || names.includes("ResponseAborted")
    || record.code === "UND_ERR_ABORTED";
}

export function workerRequestNeedsUserContext(pathname: string, method: string): boolean {
  if (pathname === "/api/models") return true;
  if (pathname === "/api/agent/new") return true;
  if (/^\/api\/agent\/[^/]+\/events$/u.test(pathname)) return true;
  if (/^\/api\/agent\/[^/]+$/u.test(pathname) && method.toUpperCase() === "POST") return true;
  return /^\/api\/sessions\/[^/]+\/auto-name$/u.test(pathname);
}

export async function workerRequestContext(
  gateway: PeGatewayRuntime,
  session: GatewaySession,
  user: PeBackendUser,
): Promise<PeWorkerRequestContext> {
  const userName = user.nickName?.trim()
    || user.email.split("@", 1)[0]?.trim()
    || "用户";
  const source = gateway.models.sourceForUser(user.id);
  if (source === "custom") return { userName, source };
  const platform = await gateway.models.platformRuntime(session, user);
  if (!platform) throw new Error("Platform model context is unavailable");
  return { userName, source, platform };
}

function forwardedRequestHeaders(
  source: Headers,
  target: WorkerTarget,
  context?: PeWorkerRequestContext,
): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  headers.set("x-pe-worker-capability", target.capability);
  headers.set("x-forwarded-proto", "https");
  if (context) {
    for (const [name, value] of Object.entries(
      createPeWorkerContextHeaders(context, target.capability),
    )) {
      headers.set(name, value);
    }
  }
  return headers;
}

function forwardedResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  headers.set("x-pe-worker-proxied", "1");
  return headers;
}

export async function forwardPeWorkerRequest(
  request: Request,
  target: WorkerTarget,
  context?: PeWorkerRequestContext,
  fetchImplementation: typeof fetch = fetch,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, `${target.baseUrl}/`);
  const method = request.method.toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: forwardedRequestHeaders(request.headers, target, context),
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  const response = await fetchImplementation(targetUrl, init);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: forwardedResponseHeaders(response.headers),
  });
}
