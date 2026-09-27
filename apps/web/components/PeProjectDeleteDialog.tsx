"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { PeProjectSummary } from "@/lib/pe-project-types";

interface Props {
  project: PeProjectSummary | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function PeProjectDeleteDialog({ project, busy, error, onClose, onConfirm }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    if (!project) return;
    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [project]);

  if (!project || !portalTarget) return null;

  const closeIfIdle = () => {
    if (!busy) onClose();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pe-project-delete-title"
      aria-describedby="pe-project-delete-description"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeIfIdle();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") closeIfIdle();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.42)",
      }}
    >
      <div
        style={{
          width: 440,
          maxWidth: "100%",
          overflow: "hidden",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 12px 40px rgba(0,0,0,0.24)",
        }}
      >
        <div style={{ display: "flex", gap: 12, padding: "18px 18px 14px" }}>
          <div
            aria-hidden="true"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 34,
              flexShrink: 0,
              borderRadius: "50%",
              background: "rgba(220,38,38,0.12)",
              color: "#dc2626",
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.7 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
            </svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div id="pe-project-delete-title" style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, lineHeight: 1.45 }}>
              {t("project.deleteTitle", { name: project.name })}
            </div>
            <div id="pe-project-delete-description" style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
              {t("project.deleteConfirm", { name: project.name })}
            </div>
          </div>
        </div>

        {error && (
          <div role="alert" style={{ margin: "0 18px 14px", padding: "9px 10px", borderRadius: 6, background: "rgba(220,38,38,0.08)", color: "#dc2626", fontSize: 11, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={closeIfIdle}
            disabled={busy}
            style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 13 }}
          >
            {t("i18n.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{ padding: "7px 16px", border: 0, borderRadius: 6, background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 600, opacity: busy ? 0.65 : 1, cursor: busy ? "wait" : "pointer" }}
          >
            {busy ? t("project.deleting") : t("project.confirmDelete")}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
