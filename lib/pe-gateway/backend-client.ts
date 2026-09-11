export interface PeBackendUser {
  id: string;
  email: string;
  nickName: string | null;
  preferredLocale: "zh-CN" | "en-US";
  status: string;
  isAdmin: boolean;
  dataNamespace: string;
  balanceCny: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PeBackendAuthBundle {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PeBackendUser;
}

export interface PeRegistrationInput {
  email: string;
  code: string;
  password: string;
  nickName?: string | null;
  preferredLocale?: "zh-CN" | "en-US";
}

export interface PePlatformModels {
  models: unknown[];
  defaultModel: string | null;
  available: boolean;
  error: string | null;
}

export interface PePlatformAccessToken {
  accessToken: string;
  expiresIn: number;
  gatewayBaseUrl: string;
}

export class PeBackendError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PeBackendError";
    this.status = status;
    this.code = code;
  }
}

type FetchImplementation = typeof fetch;

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`PE backend response is missing ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`PE backend response contains invalid ${field}`);
  return value;
}

function parseUser(value: unknown): PeBackendUser {
  const data = record(value, "PE backend response is missing user");
  const locale = requiredString(data.preferred_locale, "user.preferred_locale");
  if (locale !== "zh-CN" && locale !== "en-US") {
    throw new Error("PE backend response contains invalid user.preferred_locale");
  }
  return {
    id: requiredString(data.id, "user.id").toLowerCase(),
    email: requiredString(data.email, "user.email").trim().toLowerCase(),
    nickName: nullableString(data.nick_name, "user.nick_name"),
    preferredLocale: locale,
    status: requiredString(data.status, "user.status"),
    isAdmin: data.is_admin === true,
    dataNamespace: requiredString(data.data_namespace, "user.data_namespace").toLowerCase(),
    balanceCny: requiredString(data.balance_cny, "user.balance_cny"),
    lastLoginAt: nullableString(data.last_login_at, "user.last_login_at"),
    createdAt: requiredString(data.created_at, "user.created_at"),
  };
}

function parseAuthBundle(value: unknown): PeBackendAuthBundle {
  const data = record(value, "PE backend returned an invalid authentication response");
  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("PE backend response contains invalid expires_in");
  }
  return {
    accessToken: requiredString(data.access_token, "access_token"),
    refreshToken: requiredString(data.refresh_token, "refresh_token"),
    expiresIn: Math.floor(expiresIn),
    user: parseUser(data.user),
  };
}

export class PeBackendClient {
  private readonly backendUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: FetchImplementation;

  constructor(backendUrl: string, timeoutMs: number, fetchImplementation: FetchImplementation = fetch) {
    this.backendUrl = backendUrl.replace(/\/$/u, "");
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = fetchImplementation;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.backendUrl}/api/v1/${path.replace(/^\//u, "")}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof PeBackendError) throw error;
      throw new PeBackendError(503, "backend_unavailable", "PE 用户服务暂时不可用");
    }

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      throw new PeBackendError(
        response.status,
        typeof data.code === "string" ? data.code : "backend_request_failed",
        typeof data.message === "string" ? data.message : `PE 用户服务请求失败 (${response.status})`,
      );
    }
    return payload;
  }

  async sendVerificationCode(email: string, purpose: "register" | "reset_password" | "change_password"): Promise<void> {
    await this.request("auth/verification-code", {
      method: "POST",
      body: JSON.stringify({ email, purpose }),
    });
  }

  async register(input: PeRegistrationInput): Promise<PeBackendAuthBundle> {
    return parseAuthBundle(await this.request("auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        code: input.code,
        password: input.password,
        nick_name: input.nickName ?? null,
        preferred_locale: input.preferredLocale ?? "zh-CN",
      }),
    }));
  }

  async login(email: string, password: string): Promise<PeBackendAuthBundle> {
    return parseAuthBundle(await this.request("auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }));
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    await this.request("auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email, code, new_password: newPassword }),
    });
  }

  async refresh(refreshToken: string): Promise<PeBackendAuthBundle> {
    return parseAuthBundle(await this.request("auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    }));
  }

  async logout(refreshToken: string): Promise<void> {
    await this.request("auth/logout", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  }

  async me(accessToken: string): Promise<PeBackendUser> {
    return parseUser(await this.request("me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    }));
  }

  async updateProfile(accessToken: string, nickName: string | null): Promise<PeBackendUser> {
    return parseUser(await this.request("me/profile", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ nick_name: nickName }),
    }));
  }

  async changePassword(accessToken: string, code: string, newPassword: string): Promise<void> {
    await this.request("me/password", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ code, new_password: newPassword }),
    });
  }

  async models(accessToken: string): Promise<PePlatformModels> {
    const data = record(await this.request("models", {
      headers: { Authorization: `Bearer ${accessToken}` },
    }), "PE backend returned an invalid models response");
    return {
      models: Array.isArray(data.data) ? data.data : [],
      defaultModel: nullableString(data.default_model, "default_model"),
      available: data.available === true,
      error: nullableString(data.error, "error"),
    };
  }

  async modelAccessToken(accessToken: string): Promise<PePlatformAccessToken> {
    const data = record(await this.request("model-access-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    }), "PE backend returned an invalid model token response");
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("PE backend response contains invalid model token expiry");
    }
    return {
      accessToken: requiredString(data.access_token, "model access_token"),
      expiresIn: Math.floor(expiresIn),
      gatewayBaseUrl: requiredString(data.gateway_base_url, "gateway_base_url").replace(/\/$/u, ""),
    };
  }
}
