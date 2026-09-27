"use client";

import { type FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { PeProjectSummary } from "@/lib/pe-project-types";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (project: PeProjectSummary) => void;
}

export function PeProjectCreateDialog({ open, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyTicker, setCompanyTicker] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCompanyName("");
    setCompanyTicker("");
    setError(null);
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/pe/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, companyName, companyTicker }),
      });
      const data = await response.json().catch(() => ({})) as {
        project?: PeProjectSummary;
        error?: string;
      };
      if (!response.ok || !data.project) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      onCreated(data.project);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!open || !portalTarget) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("project.create")}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.35)",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 440,
          maxWidth: "100%",
          overflow: "hidden",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700 }}>
            {t("project.create")}
          </div>
          <div style={{ marginTop: 4, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
            {t("project.createDescription")}
          </div>
        </div>

        <div style={{ display: "grid", gap: 12, padding: "16px 18px" }}>
          <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 11 }}>
            {t("project.name")}
            <input
              autoFocus
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("project.namePlaceholder")}
              style={{
                height: 36,
                padding: "0 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                outline: "none",
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontSize: 13,
              }}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 11 }}>
              {t("project.companyName")}
              <input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                placeholder={t("project.optional")}
                style={{
                  height: 36,
                  minWidth: 0,
                  padding: "0 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  outline: "none",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 11 }}>
              {t("project.companyTicker")}
              <input
                value={companyTicker}
                onChange={(event) => setCompanyTicker(event.target.value)}
                placeholder={t("project.optional")}
                style={{
                  height: 36,
                  minWidth: 0,
                  padding: "0 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  outline: "none",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              />
            </label>
          </div>
          {error && (
            <div style={{ color: "#dc2626", fontSize: 11, lineHeight: 1.45 }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 13 }}
          >
            {t("i18n.cancel")}
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: !name.trim() || busy ? 0.6 : 1, cursor: !name.trim() || busy ? "default" : "pointer" }}
          >
            {busy ? t("project.creating") : t("project.createAndOpen")}
          </button>
        </div>
      </form>
    </div>,
    portalTarget,
  );
}
