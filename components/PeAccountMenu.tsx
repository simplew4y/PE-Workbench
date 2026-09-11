"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronUp, KeyRound, LogOut, Plug, Settings, Sparkles, UserRound, X } from "lucide-react";
import {
  changePeAccountPassword,
  logoutPeAccount,
  PeAccountClientError,
  sendPeChangePasswordCode,
  type PeAccountUser,
  updatePeAccountProfile,
} from "@/lib/pe-account-client";
import {
  PE_OPEN_MODELS_EVENT,
  PE_OPEN_PLUGINS_EVENT,
  PE_OPEN_SKILLS_EVENT,
  type PeOpenConfigEventDetail,
} from "@/lib/pe-ui-events";

function errorMessage(error: unknown): string {
  return error instanceof PeAccountClientError ? error.message : "服务暂时不可用，请稍后重试";
}

function displayName(user: PeAccountUser): string {
  return user.nick_name?.trim() || user.email.split("@", 1)[0] || user.email;
}

function initials(user: PeAccountUser): string {
  return Array.from(displayName(user).trim()).slice(0, 2).join("").toUpperCase();
}

function AccountSettingsDialog({
  user,
  onClose,
  onPasswordChanged,
  onUserUpdate,
}: {
  user: PeAccountUser;
  onClose: () => void;
  onPasswordChanged: () => void;
  onUserUpdate: (user: PeAccountUser) => void;
}) {
  const [nickName, setNickName] = useState(user.nick_name ?? "");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState("");
  const [profileError, setProfileError] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState("");
  const [passwordError, setPasswordError] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileError("");
    setProfileNotice("");
    try {
      const updated = await updatePeAccountProfile(nickName);
      onUserUpdate(updated);
      setNickName(updated.nick_name ?? "");
      setProfileNotice("账户资料已保存");
    } catch (error) {
      setProfileError(errorMessage(error));
    } finally {
      setProfileBusy(false);
    }
  }

  async function sendPasswordCode() {
    setSendingCode(true);
    setPasswordError("");
    setPasswordNotice("");
    try {
      await sendPeChangePasswordCode();
      setPasswordNotice(`验证码已发送到 ${user.email}`);
    } catch (error) {
      setPasswordError(errorMessage(error));
    } finally {
      setSendingCode(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setPasswordError("");
    setPasswordNotice("");
    if (newPassword.length < 8) {
      setPasswordError("新密码至少需要 8 个字符");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("两次输入的新密码不一致");
      return;
    }
    setPasswordBusy(true);
    try {
      await changePeAccountPassword(code, newPassword);
      onPasswordChanged();
    } catch (error) {
      setPasswordError(errorMessage(error));
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/45 px-4 py-8" role="presentation">
      <section
        aria-labelledby="pe-account-settings-title"
        aria-modal="true"
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-bg-panel p-5 text-text shadow-2xl sm:p-6"
        role="dialog"
      >
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="pe-account-settings-title" className="text-lg font-semibold">账户设置</h2>
            <p className="mt-1 text-sm text-text-muted">管理个人资料和登录密码</p>
          </div>
          <button
            type="button"
            aria-label="关闭账户设置"
            className="rounded-lg p-2 text-text-muted hover:bg-bg-hover hover:text-text"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={saveProfile}>
          <div className="flex items-center gap-2 font-medium">
            <UserRound className="size-4 text-text-muted" aria-hidden="true" />
            个人资料
          </div>
          <label className="block text-sm">
            <span className="mb-1.5 block text-text-muted">邮箱</span>
            <input
              value={user.email}
              disabled
              className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 text-text-muted disabled:opacity-70"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block text-text-muted">昵称</span>
            <input
              value={nickName}
              maxLength={120}
              onChange={(event) => setNickName(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 outline-none focus:border-accent"
              placeholder="未设置昵称时显示邮箱前缀"
            />
          </label>
          {profileNotice && <p className="text-sm text-emerald-600">{profileNotice}</p>}
          {profileError && <p role="alert" className="text-sm text-red-600">{profileError}</p>}
          <button
            type="submit"
            disabled={profileBusy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {profileBusy ? "保存中…" : "保存资料"}
          </button>
        </form>

        <form className="mt-4 space-y-4 rounded-xl border border-border p-4" onSubmit={changePassword}>
          <div className="flex items-center gap-2 font-medium">
            <KeyRound className="size-4 text-text-muted" aria-hidden="true" />
            修改密码
          </div>
          <p className="text-xs leading-5 text-text-muted">修改密码需要邮箱验证码，成功后会退出当前登录。</p>
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
                onClick={sendPasswordCode}
                className="rounded-lg border border-border px-3 text-sm hover:bg-bg-hover disabled:opacity-50"
              >
                {sendingCode ? "发送中…" : "发送验证码"}
              </button>
            </span>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block text-text-muted">新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 outline-none focus:border-accent"
            />
          </label>
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
          {passwordNotice && <p className="text-sm text-emerald-600">{passwordNotice}</p>}
          {passwordError && <p role="alert" className="text-sm text-red-600">{passwordError}</p>}
          <button
            type="submit"
            disabled={passwordBusy}
            className="rounded-lg border border-red-400 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/20"
          >
            {passwordBusy ? "修改中…" : "修改密码"}
          </button>
        </form>
      </section>
    </div>
  );
}

export function PeAccountMenu({
  user,
  onLoggedOut,
  onUserUpdate,
}: {
  user: PeAccountUser;
  onLoggedOut: () => void;
  onUserUpdate: (user: PeAccountUser) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [menuError, setMenuError] = useState("");
  const [menuTarget, setMenuTarget] = useState<HTMLElement | null>(null);
  const menuRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenuTarget(document.getElementById("pe-account-menu-slot"));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  async function signOut() {
    setSigningOut(true);
    await logoutPeAccount().catch(() => undefined);
    onLoggedOut();
  }

  function requestConfig(eventName: string) {
    const detail: PeOpenConfigEventDetail = { opened: false };
    window.dispatchEvent(new CustomEvent<PeOpenConfigEventDetail>(eventName, { detail }));
    if (detail.opened) {
      setMenuError("");
      setMenuOpen(false);
      return;
    }
    setMenuError(detail.error || "当前配置暂时无法打开");
  }

  return (
    <>
      {menuTarget && createPortal(
        <div ref={menuRootRef} className="relative z-[110] p-2">
          {menuOpen && (
            <div
              role="menu"
              aria-label="用户菜单"
              className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-xl border border-border bg-bg-panel p-1.5 text-sm text-text shadow-xl"
            >
              <div className="px-2.5 py-2">
                <p className="truncate font-medium">{displayName(user)}</p>
                <p className="mt-0.5 truncate text-xs text-text-muted">{user.email}</p>
                <p className="mt-1 text-xs text-text-muted">平台余额 ¥{user.balance_cny}</p>
              </div>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-bg-hover"
                onClick={() => {
                  setMenuOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <Settings className="size-4 text-text-muted" aria-hidden="true" />
                账户设置
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-bg-hover"
                onClick={() => requestConfig(PE_OPEN_MODELS_EVENT)}
              >
                <Bot className="size-4 text-text-muted" aria-hidden="true" />
                模型设置
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-bg-hover"
                onClick={() => requestConfig(PE_OPEN_SKILLS_EVENT)}
              >
                <Sparkles className="size-4 text-text-muted" aria-hidden="true" />
                技能设置
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-bg-hover"
                onClick={() => requestConfig(PE_OPEN_PLUGINS_EVENT)}
              >
                <Plug className="size-4 text-text-muted" aria-hidden="true" />
                插件设置
              </button>
              {menuError && <p className="px-2.5 py-1.5 text-xs text-red-600">{menuError}</p>}
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                role="menuitem"
                disabled={signingOut}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/20"
                onClick={() => void signOut()}
              >
                <LogOut className="size-4" aria-hidden="true" />
                {signingOut ? "退出中…" : "退出登录"}
              </button>
            </div>
          )}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="打开个人中心"
            title={displayName(user)}
            onClick={() => {
              setMenuError("");
              setMenuOpen((open) => !open);
            }}
            className="flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
              {initials(user)}
            </span>
            <span className="min-w-0 flex-1 truncate">{displayName(user)}</span>
            <ChevronUp className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          </button>
        </div>,
        menuTarget,
      )}
      {settingsOpen && (
        <AccountSettingsDialog
          user={user}
          onClose={() => setSettingsOpen(false)}
          onPasswordChanged={onLoggedOut}
          onUserUpdate={onUserUpdate}
        />
      )}
    </>
  );
}
