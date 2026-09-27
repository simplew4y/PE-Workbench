import { NextResponse, type NextRequest } from "next/server";
import { PeBackendError } from "./backend-client.ts";
import type { PeGatewayConfig } from "./config.ts";
import type { PeBackendUser } from "./backend-client.ts";

export class PeRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PeRequestError";
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && !(mediaType?.startsWith("application/") && mediaType.endsWith("+json"))) {
    throw new PeRequestError(415, "json_required", "请求必须使用 application/json");
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new PeRequestError(400, "invalid_json", "请求内容不是有效的 JSON 对象");
  }
}

export function publicUser(user: PeBackendUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    nick_name: user.nickName,
    preferred_locale: user.preferredLocale,
    status: user.status,
    is_admin: user.isAdmin,
    data_namespace: user.dataNamespace,
    balance_cny: user.balanceCny,
    last_login_at: user.lastLoginAt,
    created_at: user.createdAt,
  };
}

export function sessionIdFromRequest(request: NextRequest, config: PeGatewayConfig): string {
  return request.cookies.get(config.cookie.name)?.value ?? "";
}

export function setSessionCookie(response: NextResponse, sessionId: string, config: PeGatewayConfig): void {
  response.cookies.set({
    name: config.cookie.name,
    value: sessionId,
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: "lax",
    path: config.cookie.path,
    maxAge: config.sessionTtlSeconds,
  });
}

export function clearSessionCookie(response: NextResponse, config: PeGatewayConfig): void {
  response.cookies.set({
    name: config.cookie.name,
    value: "",
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: "lax",
    path: config.cookie.path,
    maxAge: 0,
  });
}

export function noStoreJson(body: unknown, init: ResponseInit = {}): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function gatewayError(error: unknown): NextResponse {
  if (error instanceof PeRequestError) {
    return noStoreJson({ code: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof PeBackendError) {
    return noStoreJson({ code: error.code, message: error.message }, { status: error.status });
  }
  console.error("PE gateway request failed", error);
  return noStoreJson(
    { code: "gateway_internal_error", message: "PE Workbench 用户服务发生内部错误" },
    { status: 500 },
  );
}

export function unauthenticated(): NextResponse {
  return noStoreJson({ code: "not_authenticated", message: "请先登录" }, { status: 401 });
}
