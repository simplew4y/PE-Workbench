"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { PeAccountMenu } from "@/components/PeAccountMenu";
import {
  getCurrentPeUser,
  getPeModelServiceState,
  getPeRuntimeInfo,
  loginPeAccount,
  PeAccountClientError,
  registerPeAccount,
  resetPeAccountPassword,
  sendPePasswordResetCode,
  sendPeRegistrationCode,
  type PeAccountUser,
} from "@/lib/pe-account-client";
import {
  PE_MODEL_SERVICE_CHANGED_EVENT,
  PE_OPEN_MODELS_EVENT,
  type PeModelServiceChangedEventDetail,
} from "@/lib/pe-ui-events";

type AccountMode = "login" | "register" | "forgot";

type AccountGateState =
  | { status: "checking" }
  | { status: "local"; accountEnabled?: boolean }
  | { status: "authenticated"; user: PeAccountUser }
  | { status: "unauthenticated" }
  | { status: "error"; message: string };

function messageFor(error: unknown): string {
  return error instanceof PeAccountClientError ? error.message : "服务暂时不可用，请稍后重试";
}

function AccountCheckingScreen() {
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-bg px-4 text-text"
      aria-busy="true"
      aria-live="polite"
    >
      <section className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-border bg-bg-panel px-8 py-10 text-center shadow-sm">
        <span className="relative flex size-14 items-center justify-center rounded-2xl bg-accent text-white shadow-sm">
          <ShieldCheck className="size-7" aria-hidden="true" />
          <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border-2 border-bg-panel bg-bg-panel text-accent">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          </span>
        </span>
        <h1 className="mt-5 text-base font-semibold">正在验证登录状态</h1>
        <p className="mt-2 text-sm text-text-muted">正在安全连接 PE Workbench，请稍候…</p>
        <div className="mt-6 h-1 w-32 overflow-hidden rounded-full bg-bg">
          <div className="h-full w-2/3 animate-pulse rounded-full bg-accent" />
        </div>
      </section>
    </main>
  );
}

function AccountCheckError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 text-text">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-bg-panel p-8 text-center shadow-sm">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-bg text-text-muted">
          <ShieldCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="mt-5 text-base font-semibold">暂时无法验证登录状态</h1>
        <p role="alert" className="mt-2 text-sm text-text-muted">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          重新检查
        </button>
      </section>
    </main>
  );
}

function PlatformBalanceWarning({ onDismiss }: { onDismiss: () => void }) {
  return (
    <aside
      role="alert"
      className="fixed right-3 top-3 z-[1400] flex w-[min(380px,calc(100vw-24px))] items-start gap-3 rounded-lg border border-border bg-bg-panel p-3 text-text shadow-[0_12px_32px_-16px_rgba(0,0,0,0.45)] sm:right-4 sm:top-4"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-accent">
        <AlertTriangle className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-5">平台模型暂不可用</p>
        <p className="mt-0.5 text-xs leading-5 text-text-muted">账户余额不足，请充值或切换到使用自己 API Key 的自定义模型。</p>
        <button
          type="button"
          className="mt-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs font-medium text-text hover:bg-bg-hover"
          onClick={() => window.dispatchEvent(new CustomEvent(PE_OPEN_MODELS_EVENT))}
        >
          切换模型
        </button>
      </div>
      <button
        type="button"
        aria-label="关闭余额提醒"
        className="rounded p-1 text-text-dim hover:bg-bg-hover hover:text-text"
        onClick={onDismiss}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </aside>
  );
}

function AccountScreen({ onAuthenticated, onLocal }: { onAuthenticated: (user: PeAccountUser) => void; onLocal?: () => void }) {
  const [mode, setMode] = useState<AccountMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [nickName, setNickName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot") {
        if (password !== confirmPassword) {
          setError("两次输入的密码不一致");
          return;
        }
        await resetPeAccountPassword({ email, code, newPassword: password });
        setMode("login");
        setCode("");
        setPassword("");
        setConfirmPassword("");
        setNotice("密码已重置，请使用新密码登录");
      } else {
        const user = mode === "login"
          ? await loginPeAccount(email, password)
          : await registerPeAccount({ email, password, code, nickName });
        onAuthenticated(user);
      }
    } catch (submitError) {
      setError(messageFor(submitError));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    if (!email.trim()) {
      setError("请先输入邮箱");
      return;
    }
    setSendingCode(true);
    setError("");
    setNotice("");
    try {
      if (mode === "forgot") await sendPePasswordResetCode(email);
      else await sendPeRegistrationCode(email);
      setNotice("验证码已发送，请检查邮箱");
    } catch (sendError) {
      setError(messageFor(sendError));
    } finally {
      setSendingCode(false);
    }
  }

  return (
    <main className="min-h-dvh bg-bg px-4 py-10 text-text">
      <div className="mx-auto flex min-h-[calc(100dvh-5rem)] max-w-md items-center">
        <section className="w-full rounded-2xl border border-border bg-bg-panel p-6 shadow-sm sm:p-8">
          <div className="mb-7 flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-white">
              <ShieldCheck className="size-6" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-xl font-semibold">PE Workbench</h1>
              <p className="mt-1 text-sm text-text-muted">私募投研工作台</p>
            </div>
          </div>

          {mode === "forgot" ? (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError("");
                  setNotice("");
                }}
                className="text-sm text-accent hover:underline"
              >
                ← 返回登录
              </button>
              <h2 className="mt-4 text-lg font-semibold">重置密码</h2>
              <p className="mt-1 text-sm text-text-muted">使用邮箱验证码设置新密码</p>
            </div>
          ) : (
            <div className="mb-6 grid grid-cols-2 rounded-lg bg-bg p-1">
              {(["login", "register"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setMode(item);
                    setError("");
                    setNotice("");
                  }}
                  className={`rounded-md px-3 py-2 text-sm transition-colors ${mode === item ? "bg-accent text-white" : "text-text-muted hover:text-text"}`}
                >
                  {item === "login" ? "登录" : "注册"}
                </button>
              ))}
            </div>
          )}

          <form className="space-y-4" onSubmit={submit}>
            <label className="block text-sm">
              <span className="mb-1.5 block text-text-muted">邮箱</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 outline-none focus:border-accent"
              />
            </label>

            {mode !== "login" && (
              <>
                {mode === "register" && (
                  <label className="block text-sm">
                    <span className="mb-1.5 block text-text-muted">昵称（可选）</span>
                    <input
                      value={nickName}
                      onChange={(event) => setNickName(event.target.value)}
                      className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 outline-none focus:border-accent"
                    />
                  </label>
                )}
                <label className="block text-sm">
                  <span className="mb-1.5 block text-text-muted">验证码</span>
                  <span className="flex gap-2">
                    <input
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2.5 outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      disabled={sendingCode}
                      onClick={sendCode}
                      className="rounded-lg border border-border px-3 text-sm hover:bg-bg-hover disabled:opacity-50"
                    >
                      {sendingCode ? "发送中" : "发送验证码"}
                    </button>
                  </span>
                </label>
              </>
            )}

            <label className="block text-sm">
              <span className="mb-1.5 block text-text-muted">{mode === "forgot" ? "新密码" : "密码"}</span>
              <input
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "login" ? 1 : 8}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 outline-none focus:border-accent"
              />
            </label>

            {mode === "forgot" && (
              <label className="block text-sm">
                <span className="mb-1.5 block text-text-muted">确认新密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 outline-none focus:border-accent"
                />
              </label>
            )}

            {mode === "login" && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot");
                    setCode("");
                    setPassword("");
                    setConfirmPassword("");
                    setError("");
                    setNotice("");
                  }}
                  className="text-sm text-accent hover:underline"
                >
                  忘记密码？
                </button>
              </div>
            )}

            {notice && <p className="text-sm text-emerald-600">{notice}</p>}
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "请稍候…" : mode === "login" ? "登录" : mode === "register" ? "创建账号" : "重置密码"}
            </button>
          </form>
          {onLocal && <button type="button" onClick={onLocal} className="mt-4 w-full rounded-lg border border-border px-4 py-2.5 text-sm text-text-muted hover:bg-bg-hover">暂不登录，使用本地功能</button>}
        </section>
      </div>
    </main>
  );
}

export function PeAccountGate({ children }: { children: ReactNode }) {
  const [gateState, setGateState] = useState<AccountGateState>({ status: "checking" });
  const [platformBalanceBlocked, setPlatformBalanceBlocked] = useState(false);
  const [balanceWarningDismissed, setBalanceWarningDismissed] = useState(false);
  const requestSequence = useRef(0);
  const desktopMode = useRef(false);
  const authenticatedUserId = gateState.status === "authenticated" ? gateState.user.id : null;
  const authenticatedBalance = gateState.status === "authenticated" ? gateState.user.balance_cny : null;

  const bootstrap = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setGateState({ status: "checking" });
    try {
      const runtime = await getPeRuntimeInfo();
      const multiUser = runtime.multi_user;
      desktopMode.current = runtime.desktop;
      if (sequence !== requestSequence.current) return;
      if (!multiUser) {
        setGateState({ status: "local" });
        return;
      }

      try {
        const user = await getCurrentPeUser();
        if (sequence === requestSequence.current) {
          setGateState({ status: "authenticated", user });
        }
      } catch (error) {
        if (sequence !== requestSequence.current) return;
        if (desktopMode.current && error instanceof PeAccountClientError
          && (error.status === 401 || error.status >= 500)) {
          setGateState({ status: "local", accountEnabled: true });
          return;
        }
        if (error instanceof PeAccountClientError && [401, 403].includes(error.status)) {
          setGateState({ status: "unauthenticated" });
        } else {
          setGateState({ status: "error", message: messageFor(error) });
        }
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        setGateState({ status: "error", message: messageFor(error) });
      }
    }
  }, []);

  useEffect(() => {
    void bootstrap();
    return () => { requestSequence.current += 1; };
  }, [bootstrap]);

  const refreshAuthenticatedUser = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const user = await getCurrentPeUser();
      if (sequence === requestSequence.current) {
        setGateState({ status: "authenticated", user });
      }
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      if (error instanceof PeAccountClientError && [401, 403].includes(error.status)) {
        setGateState({ status: "unauthenticated" });
      }
    }
  }, []);

  useEffect(() => {
    if (gateState.status !== "authenticated") return;
    const onFocus = () => { void refreshAuthenticatedUser(); };
    const timer = window.setInterval(() => { void refreshAuthenticatedUser(); }, 5 * 60_000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [gateState.status, refreshAuthenticatedUser]);

  useEffect(() => {
    if (gateState.status !== "authenticated") {
      setPlatformBalanceBlocked(false);
      return;
    }
    let active = true;
    const updateBalanceState = (source: "platform" | "custom", balanceCny: string) => {
      if (!active) return;
      const balance = Number(balanceCny);
      const blocked = source === "platform" && Number.isFinite(balance) && balance <= 0;
      setPlatformBalanceBlocked(blocked);
      if (blocked) setBalanceWarningDismissed(false);
    };
    void getPeModelServiceState()
      .then((state) => updateBalanceState(state.source, state.platform.balance_cny))
      .catch(() => {});
    const onModelServiceChanged = (event: Event) => {
      const detail = (event as CustomEvent<PeModelServiceChangedEventDetail>).detail;
      if (detail) updateBalanceState(detail.source, detail.balanceCny);
    };
    window.addEventListener(PE_MODEL_SERVICE_CHANGED_EVENT, onModelServiceChanged);
    return () => {
      active = false;
      window.removeEventListener(PE_MODEL_SERVICE_CHANGED_EVENT, onModelServiceChanged);
    };
  }, [authenticatedBalance, authenticatedUserId, gateState.status]);

  if (gateState.status === "checking") {
    return <AccountCheckingScreen />;
  }
  if (gateState.status === "local") return <>{children}<PeAccountMenu user={null}
    onLoggedOut={() => {}} onUserUpdate={() => {}}
    onLogin={gateState.accountEnabled ? () => setGateState({ status: "unauthenticated" }) : undefined}
    onReconnect={gateState.accountEnabled ? () => { void bootstrap(); } : undefined}
  /></>;
  if (gateState.status === "error") {
    return <AccountCheckError message={gateState.message} onRetry={() => { void bootstrap(); }} />;
  }
  if (gateState.status === "unauthenticated") {
    return (
      <AccountScreen
        onLocal={desktopMode.current ? () => setGateState({ status: "local", accountEnabled: true }) : undefined}
        onAuthenticated={(user) => {
          requestSequence.current += 1;
          setGateState({ status: "authenticated", user });
        }}
      />
    );
  }

  const user = gateState.user;

  return (
    <>
      {children}
      {platformBalanceBlocked && !balanceWarningDismissed && (
        <PlatformBalanceWarning onDismiss={() => setBalanceWarningDismissed(true)} />
      )}
      <PeAccountMenu
        user={user}
        onReconnect={() => { void refreshAuthenticatedUser(); }}
        onLoggedOut={() => {
          requestSequence.current += 1;
          setGateState(desktopMode.current ? { status: "local", accountEnabled: true } : { status: "unauthenticated" });
        }}
        onUserUpdate={(updatedUser) => setGateState({ status: "authenticated", user: updatedUser })}
      />
    </>
  );
}
