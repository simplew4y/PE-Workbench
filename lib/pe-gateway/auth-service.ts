import {
  PeBackendClient,
  PeBackendError,
  type PeBackendAuthBundle,
  type PeBackendUser,
  type PeRegistrationInput,
} from "./backend-client.ts";
import { type GatewaySession, PeGatewaySessionStore } from "./session-store.ts";

export interface AuthenticatedSession {
  sessionId: string;
  session: GatewaySession;
  user?: PeBackendUser;
}

export class PeGatewayAuthService {
  private readonly refreshLocks = new Map<string, Promise<GatewaySession | null>>();

  constructor(
    private readonly backend: PeBackendClient,
    private readonly store: PeGatewaySessionStore,
    private readonly sessionTtlSeconds: number,
  ) {}

  private validatedUser(
    sessionId: string,
    session: GatewaySession,
    user: PeBackendUser,
  ): PeBackendUser {
    if (user.id !== session.userId || user.dataNamespace !== session.dataNamespace) {
      this.store.deleteSession(sessionId);
      this.store.revokeWorkerCapabilities(session.userId);
      throw new PeBackendError(401, "session_identity_changed", "登录身份校验失败，请重新登录");
    }
    if (user.status !== "active") {
      this.store.deleteSession(sessionId);
      this.store.revokeWorkerCapabilities(session.userId);
      throw new PeBackendError(403, "account_disabled", "账号已被停用");
    }
    return user;
  }

  private persistBundle(bundle: PeBackendAuthBundle, now: number): AuthenticatedSession {
    if (bundle.user.status !== "active") {
      throw new PeBackendError(403, "account_disabled", "账号已被停用");
    }
    const sessionId = this.store.createSession({
      userId: bundle.user.id,
      dataNamespace: bundle.user.dataNamespace,
      email: bundle.user.email,
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      accessExpiresAt: now + bundle.expiresIn,
      sessionExpiresAt: now + this.sessionTtlSeconds,
    }, now);
    return { sessionId, session: this.store.getSession(sessionId, now)!, user: bundle.user };
  }

  async login(email: string, password: string, now = Math.floor(Date.now() / 1000)): Promise<AuthenticatedSession> {
    return this.persistBundle(await this.backend.login(email, password), now);
  }

  async register(input: PeRegistrationInput, now = Math.floor(Date.now() / 1000)): Promise<AuthenticatedSession> {
    return this.persistBundle(await this.backend.register(input), now);
  }

  async sendVerificationCode(email: string): Promise<void> {
    await this.backend.sendVerificationCode(email, "register");
  }

  async sendPasswordResetCode(email: string): Promise<void> {
    await this.backend.sendVerificationCode(email, "reset_password");
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    await this.backend.resetPassword(email, code, newPassword);
  }

  private async refreshUnlocked(sessionId: string, now: number): Promise<GatewaySession | null> {
    const session = this.store.getSession(sessionId, now);
    if (!session) return null;
    try {
      const bundle = await this.backend.refresh(session.refreshToken);
      if (bundle.user.id !== session.userId || bundle.user.dataNamespace !== session.dataNamespace) {
        this.store.deleteSession(sessionId);
        this.store.revokeWorkerCapabilities(session.userId);
        throw new PeBackendError(401, "session_identity_changed", "登录身份校验失败，请重新登录");
      }
      const updated = this.store.updateTokens(
        sessionId,
        bundle.accessToken,
        bundle.refreshToken,
        now + bundle.expiresIn,
        now,
      );
      return updated ? this.store.getSession(sessionId, now) : null;
    } catch (error) {
      if (error instanceof PeBackendError && [401, 403].includes(error.status)) {
        this.store.deleteSession(sessionId);
        this.store.revokeWorkerCapabilities(session.userId);
      }
      throw error;
    }
  }

  async requireSession(
    sessionId: string,
    options: { forceRefresh?: boolean; now?: number } = {},
  ): Promise<GatewaySession | null> {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const session = this.store.getSession(sessionId, now);
    if (!session) return null;
    if (!options.forceRefresh && session.accessExpiresAt > now + 30) return session;

    const existing = this.refreshLocks.get(sessionId);
    if (existing) return existing;
    const refresh = this.refreshUnlocked(sessionId, now).finally(() => {
      if (this.refreshLocks.get(sessionId) === refresh) this.refreshLocks.delete(sessionId);
    });
    this.refreshLocks.set(sessionId, refresh);
    return refresh;
  }

  async currentUser(sessionId: string, now = Math.floor(Date.now() / 1000)): Promise<PeBackendUser | null> {
    const session = await this.requireSession(sessionId, { now });
    if (!session) return null;
    try {
      const user = await this.backend.me(session.accessToken);
      return this.validatedUser(sessionId, session, user);
    } catch (error) {
      if (error instanceof PeBackendError && error.status === 403) {
        this.store.deleteSession(sessionId);
        this.store.revokeWorkerCapabilities(session.userId);
        throw error;
      }
      if (error instanceof PeBackendError && error.status === 401) {
        const refreshed = await this.requireSession(sessionId, { forceRefresh: true, now });
        if (refreshed) {
          const user = await this.backend.me(refreshed.accessToken);
          return this.validatedUser(sessionId, refreshed, user);
        }
      }
      throw error;
    }
  }

  async updateProfile(
    sessionId: string,
    nickName: string | null,
    now = Math.floor(Date.now() / 1000),
  ): Promise<PeBackendUser | null> {
    let session = await this.requireSession(sessionId, { now });
    if (!session) return null;
    try {
      const user = await this.backend.updateProfile(session.accessToken, nickName);
      return this.validatedUser(sessionId, session, user);
    } catch (error) {
      if (error instanceof PeBackendError && error.status === 403) {
        this.store.deleteSession(sessionId);
        this.store.revokeWorkerCapabilities(session.userId);
        throw error;
      }
      if (!(error instanceof PeBackendError) || error.status !== 401) throw error;
      session = await this.requireSession(sessionId, { forceRefresh: true, now });
      if (!session) return null;
      const user = await this.backend.updateProfile(session.accessToken, nickName);
      return this.validatedUser(sessionId, session, user);
    }
  }

  async sendChangePasswordCode(sessionId: string): Promise<boolean> {
    const user = await this.currentUser(sessionId);
    if (!user) return false;
    await this.backend.sendVerificationCode(user.email, "change_password");
    return true;
  }

  async changePassword(sessionId: string, code: string, newPassword: string): Promise<boolean> {
    let session = await this.requireSession(sessionId);
    if (!session) return false;
    try {
      await this.backend.changePassword(session.accessToken, code, newPassword);
    } catch (error) {
      if (!(error instanceof PeBackendError) || error.status !== 401) throw error;
      session = await this.requireSession(sessionId, { forceRefresh: true });
      if (!session) return false;
      await this.backend.changePassword(session.accessToken, code, newPassword);
    }
    this.store.revokeWorkerCapabilities(session.userId);
    this.store.deleteSession(sessionId);
    return true;
  }

  async logout(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (session) {
      try {
        await this.backend.logout(session.refreshToken);
      } catch {
        // Local logout must succeed even when the account service is unavailable.
      }
      this.store.revokeWorkerCapabilities(session.userId);
    }
    this.store.deleteSession(sessionId);
  }
}
