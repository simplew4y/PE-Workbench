import { PeBackendError, type PeBackendUser } from "./backend-client.ts";
import type { PeGatewayRuntime } from "./runtime.ts";
import { isPeDesktopMode } from "../pe-desktop-mode.ts";

export function isCloudUnavailable(error: unknown): boolean {
  return error instanceof PeBackendError && error.status >= 500 && error.status <= 599;
}

const retryAfter = new Map<string, number>();

/** Cached identity is for local operations only, never cloud authorization. */
export async function localAccountContext(gateway: PeGatewayRuntime, sessionId: string) {
  const cached = gateway.store.getSession(sessionId);
  if (!cached) return null;
  try {
    if (isPeDesktopMode() && (retryAfter.get(sessionId) ?? 0) > Date.now()) {
      throw new PeBackendError(503, "backend_unavailable", "用户服务未连接");
    }
    const user = await gateway.auth.currentUser(sessionId);
    const session = await gateway.auth.requireSession(sessionId);
    retryAfter.delete(sessionId);
    return user && session ? { user, session, offline: false } : null;
  } catch (error) {
    if (!isPeDesktopMode() || !isCloudUnavailable(error)) throw error;
    if ((retryAfter.get(sessionId) ?? 0) <= Date.now()) retryAfter.set(sessionId, Date.now() + 15_000);
    if (retryAfter.size > 100) for (const [key, expiry] of retryAfter) if (expiry < Date.now()) retryAfter.delete(key);
    // Re-read: an explicit invalidation must not be resurrected by fallback.
    const session = gateway.store.getSession(sessionId);
    if (!session) return null;
    const user: PeBackendUser = {
      id: session.userId, dataNamespace: session.dataNamespace, email: session.email,
      nickName: null, preferredLocale: "zh-CN", status: "offline", isAdmin: false,
      balanceCny: "unknown", lastLoginAt: null, createdAt: new Date(session.createdAt * 1000).toISOString(),
    };
    return { user, session, offline: true };
  }
}
