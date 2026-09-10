"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { joinFilePath } from "@/lib/file-paths";
import type {
  PeProjectDocumentCatalog,
  PeProjectDocumentStatus,
  PeProjectDocumentSummary,
  PeProjectSummary,
} from "@/lib/pe-project-types";

interface Props {
  project?: PeProjectSummary;
  refreshKey?: number;
  onOpenFile?: (filePath: string, fileName: string) => void;
}

function formatFileSize(sizeBytes: number | null): string | null {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusColor(status: PeProjectDocumentStatus, needsOcrPageCount: number): string {
  if (status === "failed") return "#dc2626";
  if (status === "queued" || status === "running") return "var(--accent)";
  if (status === "completed_with_warnings" || needsOcrPageCount > 0) return "#d97706";
  return "#15803d";
}

export function PeProjectDocuments({ project, refreshKey = 0, onOpenFile }: Props) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [documents, setDocuments] = useState<PeProjectDocumentSummary[]>([]);
  const [currentCount, setCurrentCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);

  useEffect(() => {
    if (!project) {
      setDocuments([]);
      setCurrentCount(0);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const load = async (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      try {
        const query = new URLSearchParams({ datasetId: project.datasetId });
        const response = await fetch(`/api/pe/documents?${query.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({})) as PeProjectDocumentCatalog & { error?: string };
        if (!response.ok || !Array.isArray(body.documents)) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        if (cancelled) return;
        setDocuments(body.documents);
        setCurrentCount(body.currentCount ?? body.documents.filter((document) => document.isCurrent !== false).length);
        setError(null);
        if (body.documents.some((document) => document.status === "queued" || document.status === "running")) {
          timer = setTimeout(() => void load(false), 1500);
        }
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
    };
    void load(true);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [project, refreshKey, reloadKey]);

  const hasAttention = documents.some((document) => document.isCurrent !== false && (
    document.status === "failed"
    || document.status === "completed_with_warnings"
    || document.needsOcrPageCount > 0
  ));
  const openProjectFile = (relativePath: string, fileName: string) => {
    if (!project || !onOpenFile) return;
    onOpenFile(joinFilePath(project.root, relativePath), fileName);
  };
  const retryDocument = async (docId: string) => {
    if (!project || retryingDocId) return;
    setRetryingDocId(docId);
    setError(null);
    try {
      const response = await fetch("/api/pe/ingest/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: project.datasetId, docId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setReloadKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetryingDocId(null);
    }
  };

  return (
    <div style={{ marginTop: 8, border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", minHeight: 34 }}>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? t("projectDocuments.collapse") : t("projectDocuments.expand")}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 34,
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "0 9px",
            border: 0,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 650,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
          <span style={{ whiteSpace: "nowrap" }}>{t("projectDocuments.title")}</span>
          <span style={{ color: hasAttention ? "#d97706" : "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            {currentCount}
          </span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ marginLeft: "auto", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 120ms ease" }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          aria-label={t("projectDocuments.refresh")}
          title={t("projectDocuments.refresh")}
          style={{ width: 30, height: 30, marginRight: 2, border: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" />
            <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
          </svg>
        </button>
      </div>

      {expanded && (
        <div style={{ maxHeight: 230, overflowY: "auto", borderTop: "1px solid var(--border)" }}>
          {documents.some((document) => document.isCurrent === false) && (
            <label style={{ display: "block", padding: "7px 9px", fontSize: 10.5, color: "var(--text-muted)" }}>
              <input type="checkbox" checked={showHistory} onChange={(event) => setShowHistory(event.target.checked)} />
              {locale.startsWith("zh") ? " 显示历史版本" : " Show previous versions"}
            </label>
          )}
          {!project && (
            <div style={{ padding: "9px 10px", color: "var(--text-dim)", fontSize: 10.5 }}>
              {t("projectDocuments.noProject")}
            </div>
          )}
          {project && loading && documents.length === 0 && (
            <div style={{ padding: "9px 10px", color: "var(--text-dim)", fontSize: 10.5 }}>
              {t("projectDocuments.loading")}
            </div>
          )}
          {project && !loading && !error && documents.length === 0 && (
            <div style={{ padding: "9px 10px", color: "var(--text-dim)", fontSize: 10.5 }}>
              {t("projectDocuments.empty")}
            </div>
          )}
          {error && (
            <div role="alert" style={{ padding: "9px 10px", color: "#dc2626", fontSize: 10.5, overflowWrap: "anywhere" }}>
              {t("projectDocuments.loadFailed")}: {error}
            </div>
          )}
          {documents.filter((document) => showHistory || document.isCurrent !== false).map((document) => {
            const docId = document.docId;
            const rawRelativePath = document.rawRelativePath;
            const markdownRelativePath = document.markdownRelativePath;
            const color = statusColor(document.status, document.needsOcrPageCount);
            const size = formatFileSize(document.sizeBytes);
            const uploadedAt = new Date(document.uploadedAt);
            const metadata = [
              document.fileType.toUpperCase(),
              document.versionNo ? `v${document.versionNo}${document.isCurrent === false ? (locale.startsWith("zh") ? " · 历史" : " · previous") : (locale.startsWith("zh") ? " · 当前" : " · current")}` : null,
              size,
              document.pageCount > 0 ? t("projectDocuments.pages", { count: document.pageCount }) : null,
              document.sheetCount > 0 ? t("projectDocuments.sheets", { count: document.sheetCount }) : null,
              document.formulaCount > 0 ? t("projectDocuments.formulas", { count: document.formulaCount }) : null,
              Number.isNaN(uploadedAt.getTime())
                ? null
                : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(uploadedAt),
            ].filter((item): item is string => Boolean(item));
            let statusLabel = t("projectDocuments.statusCompleted");
            const coverMetadata = [document.brokerage, document.documentDate, document.rating, document.targetPrice]
              .filter((item): item is string => Boolean(item));
            if (document.needsOcrPageCount > 0) {
              statusLabel = t("projectDocuments.statusNeedsOcr", { count: document.needsOcrPageCount });
            } else if (document.status === "queued") {
              statusLabel = t("projectDocuments.statusQueued");
            } else if (document.status === "running") {
              statusLabel = t("projectDocuments.statusRunning");
            } else if (document.status === "completed_with_warnings") {
              statusLabel = t("projectDocuments.statusWarnings");
            } else if (document.status === "failed") {
              statusLabel = t("projectDocuments.statusFailed");
            }
            return (
              <div key={document.docId ?? document.filename} style={{ padding: "8px 9px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div title={document.filename} style={{ color: "var(--text)", fontSize: 11, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {document.title ?? document.filename}
                    </div>
                    {document.title && (
                      <div title={document.filename} style={{ marginTop: 1, color: "var(--text-dim)", fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {document.filename}
                      </div>
                    )}
                    {coverMetadata.length > 0 && (
                      <div title={coverMetadata.join(" · ")} style={{ marginTop: 2, fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {coverMetadata.join(" · ")}
                      </div>
                    )}
                    <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.3 }}>
                      {metadata.join(" · ")}
                    </div>
                  </div>
                  <span title={document.warnings.join("\n")} style={{ flexShrink: 0, color, fontSize: 9.5, lineHeight: 1.35 }}>
                    {statusLabel}
                  </span>
                </div>
                {document.warnings.length > 0 && (
                  <div title={document.warnings.join("\n")} style={{ marginTop: 4, color, fontSize: 9.5, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {document.warnings[0]}
                  </div>
                )}
                {(rawRelativePath || markdownRelativePath || (docId && document.retryable)) && (
                  <div style={{ display: "flex", gap: 10, marginTop: 5 }}>
                    {rawRelativePath && (
                      <button
                        type="button"
                        onClick={() => openProjectFile(rawRelativePath, document.filename)}
                        disabled={!project || !onOpenFile}
                        style={{ padding: 0, border: 0, background: "transparent", color: "var(--accent)", cursor: project && onOpenFile ? "pointer" : "default", fontSize: 9.5 }}
                      >
                        {t("projectDocuments.previewOriginal")}
                      </button>
                    )}
                    {markdownRelativePath && (
                      <button
                        type="button"
                        onClick={() => openProjectFile(markdownRelativePath, markdownRelativePath.split("/").pop() ?? document.filename)}
                        disabled={!project || !onOpenFile}
                        style={{ padding: 0, border: 0, background: "transparent", color: "var(--accent)", cursor: project && onOpenFile ? "pointer" : "default", fontSize: 9.5 }}
                      >
                        {t("projectDocuments.previewText")}
                      </button>
                    )}
                    {docId && document.retryable && (
                      <button
                        type="button"
                        onClick={() => void retryDocument(docId)}
                        disabled={retryingDocId !== null}
                        style={{ padding: 0, border: 0, background: "transparent", color: "var(--accent)", cursor: retryingDocId ? "wait" : "pointer", fontSize: 9.5 }}
                      >
                        {retryingDocId === docId
                          ? t("projectDocuments.retrying")
                          : t("projectDocuments.retry")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
