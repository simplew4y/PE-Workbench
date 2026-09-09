export interface PeAccountUser {
  id: string;
  email: string;
  nick_name: string | null;
  preferred_locale: "zh-CN" | "en-US";
  status: string;
  is_admin: boolean;
  data_namespace: string;
  balance_cny: string;
  last_login_at: string | null;
  created_at: string;
}

export interface PeModelServiceClientState {
  source: "platform" | "custom";
  platform: {
    available: boolean;
    balance_cny: string;
    models: unknown[];
    default_model: string | null;
    selected_model: string | null;
    error: string | null;
  };
  custom: { configured: boolean | null };
}

export class PeAccountClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PeAccountClientError";
  }
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new PeAccountClientError(
      response.status,
      typeof data.code === "string" ? data.code : "request_failed",
      typeof data.message === "string" ? data.message : `请求失败 (${response.status})`,
    );
  }
  return payload as T;
}

export async function getPeRuntimeMode(): Promise<boolean> {
  const response = await jsonRequest<{ multi_user: boolean }>("/api/runtime-mode");
  return response.multi_user === true;
}

export function getPeModelServiceState(): Promise<PeModelServiceClientState> {
  return jsonRequest<PeModelServiceClientState>("/api/model-service");
}

export async function ensurePePromptAvailable(): Promise<void> {
  if (!await getPeRuntimeMode()) return;
  const state = await getPeModelServiceState();
  if (state.source !== "platform") return;
  const balance = Number(state.platform.balance_cny);
  if (Number.isFinite(balance) && balance <= 0) {
    throw new PeAccountClientError(
      402,
      "insufficient_balance",
      "平台余额不足",
    );
  }
  if (!state.platform.available || !state.platform.selected_model) {
    throw new PeAccountClientError(
      409,
      "platform_models_unavailable",
      state.platform.error || "当前没有可用的平台模型",
    );
  }
}

export function getCurrentPeUser(): Promise<PeAccountUser> {
  return jsonRequest<PeAccountUser>("/api/account/me");
}

export async function loginPeAccount(email: string, password: string): Promise<PeAccountUser> {
  const response = await jsonRequest<{ user: PeAccountUser }>("/api/account/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return response.user;
}

export async function sendPeRegistrationCode(email: string): Promise<void> {
  await jsonRequest("/api/account/verification-code", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function sendPePasswordResetCode(email: string): Promise<void> {
  await jsonRequest("/api/account/forgot-password-code", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPeAccountPassword(input: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<void> {
  await jsonRequest("/api/account/forgot-password", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      code: input.code,
      new_password: input.newPassword,
    }),
  });
}

export async function registerPeAccount(input: {
  email: string;
  code: string;
  password: string;
  nickName: string;
}): Promise<PeAccountUser> {
  const response = await jsonRequest<{ user: PeAccountUser }>("/api/account/register", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      code: input.code,
      password: input.password,
      nick_name: input.nickName || null,
      preferred_locale: "zh-CN",
    }),
  });
  return response.user;
}

export async function logoutPeAccount(): Promise<void> {
  await jsonRequest("/api/account/logout", { method: "POST" });
}

export async function updatePeAccountProfile(nickName: string): Promise<PeAccountUser> {
  const response = await jsonRequest<{ user: PeAccountUser }>("/api/account/profile", {
    method: "PATCH",
    body: JSON.stringify({ nick_name: nickName.trim() || null }),
  });
  return response.user;
}

export async function sendPeChangePasswordCode(): Promise<void> {
  await jsonRequest("/api/account/password-code", { method: "POST" });
}

export async function changePeAccountPassword(code: string, newPassword: string): Promise<void> {
  await jsonRequest("/api/account/password", {
    method: "POST",
    body: JSON.stringify({ code, new_password: newPassword }),
  });
}
