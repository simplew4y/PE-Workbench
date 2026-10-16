"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { useI18n } from "@/hooks/useI18n";
import { joinFilePath } from "@/lib/file-paths";
import { getFileIcon } from "./FileIcons";
import type { PeSourceScope } from "@earendil-works/pe-boot";
import { isSelectableSource, selectedSourceScope, sourceSelectionKey } from "@/lib/pe-source-selection";
import { sourceDisplayName } from "./source-display-name";
import { sourceTabId } from "./file-tab-state";
import type { SourceTarget, SourceView } from "./TabBar";
import styles from "./PeProjectDocuments.module.css";
import type {
  PeProjectDocumentCatalog,
  PeProjectDocumentSummary,
  PeProjectSummary,
} from "@/lib/pe-project-types";

interface Props {
  project?: PeProjectSummary;
  refreshKey?: number;
  activeSourceId?: string | null;
  onOpenSource?: (source: SourceTarget, view?: SourceView) => void;
  onSourcesChanged?: (sources: SourceTarget[]) => void;
  children?: ReactNode;
  selectedKeys?: string[];
  onSelectionChange?: (root: string, keys: string[]) => void;
  onScopeChange?: (root: string, scope: PeSourceScope) => void;
}

function sourceTarget(project: PeProjectSummary, document: PeProjectDocumentSummary): SourceTarget {
  return {
    datasetId: project.datasetId,
    docId: document.docId,
    versionNo: document.versionNo,
    fileName: document.filename,
    originalPath: document.rawRelativePath ? joinFilePath(project.root, document.rawRelativePath) : null,
    parsedPath: document.markdownRelativePath ? joinFilePath(project.root, document.markdownRelativePath) : null,
  };
}

export function PeProjectDocuments({ project, refreshKey = 0, activeSourceId, onOpenSource, onSourcesChanged, children, selectedKeys, onSelectionChange, onScopeChange }: Props) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [documents, setDocuments] = useState<PeProjectDocumentSummary[]>([]);
  const [currentCount, setCurrentCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [sourceAction, setSourceAction] = useState<"rename" | "remove" | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

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
        setCatalogReady(true);
        onSourcesChanged?.(body.documents.map((document) => sourceTarget(project, document)));
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
  }, [project, refreshKey, reloadKey, onSourcesChanged]);

  const available = documents.filter(isSelectableSource);
  const scope = project ? selectedSourceScope(project.datasetId, documents, selectedKeys) : null;
  const selected = new Set(scope?.documents.map(sourceSelectionKey) ?? []);
  const scopeJson = JSON.stringify(scope);
  useEffect(() => {
    if (project && catalogReady && !loading && !error && scopeJson !== "null") {
      onScopeChange?.(project.root, JSON.parse(scopeJson) as PeSourceScope);
    }
  }, [project, catalogReady, loading, error, scopeJson, onScopeChange]);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selected.size > 0 && selected.size < available.length;
  }, [selected.size, available.length]);

  const saveSourceAction = async (document: PeProjectDocumentSummary) => {
    if (!project || !sourceAction || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/pe/documents", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: project.datasetId, key: sourceSelectionKey(document), action: sourceAction, name: sourceName }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to update source");
      setDocuments((current) => sourceAction === "remove"
        ? current.filter((item) => sourceSelectionKey(item) !== sourceSelectionKey(document))
        : current.map((item) => sourceSelectionKey(item) === sourceSelectionKey(document) ? { ...item, title: sourceName.trim() } : item));
      setSourceAction(null);
      setReloadKey((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionBusy(false);
    }
  };

  const nameCounts = new Map<string, number>();
  for (const document of documents) {
    if (document.isCurrent === false) continue;
    const name = sourceDisplayName(document.filename, document.title);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return (
    <section className={styles.sources} aria-label={t("projectDocuments.title")}>
      <header className={styles.heading}>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {t("projectDocuments.title")} <span className={styles.count}>{currentCount}</span>
          <svg className={styles.chevron} data-expanded={expanded} width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
        <button type="button" onClick={() => setReloadKey((value) => value + 1)}
          aria-label={t("projectDocuments.refresh")} title={t("projectDocuments.refresh")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 0 0-15-3M4 4v4h4M4 13a8 8 0 0 0 15 3m1 4v-4h-4" />
          </svg>
        </button>
      </header>
      {children}
      {expanded && <div className={styles.list}>
        <label className={styles.selectAll}>
          <span>{locale.startsWith("zh") ? "全部资料" : "All sources"}</span>
          <input ref={selectAllRef} type="checkbox" checked={available.length > 0 && selected.size === available.length}
            disabled={!project || available.length === 0 || loading || Boolean(error)}
            onChange={(event) => project && onSelectionChange?.(project.root,
              event.target.checked ? available.map(sourceSelectionKey) : [])} />
        </label>
        {!project && <p className={styles.message}>{t("projectDocuments.noProject")}</p>}
        {project && loading && documents.length === 0 && <p className={styles.message} role="status">{t("projectDocuments.loading")}</p>}
        {project && !loading && !error && documents.length === 0 && <p className={styles.message}>{t("projectDocuments.empty")}</p>}
        {error && <p className={styles.message} role="alert">{t("projectDocuments.loadFailed")}: {error}</p>}
        <div className={styles.items}>
        {project && documents.filter((document) => document.isCurrent !== false).map((document) => {
          const target = sourceTarget(project, document);
          const id = sourceTabId(target);
          const displayName = sourceDisplayName(document.filename, document.title);
          const duplicateName = (nameCounts.get(displayName) ?? 0) > 1;
          const date = document.documentDate || (/^\d{4}-\d{2}-\d{2}/.exec(document.uploadedAt)?.[0]);
          const metadata = [
            duplicateName ? date : null,
            duplicateName && document.versionNo ? "v" + document.versionNo : null,
          ];
          const attention = document.status === "failed" || document.status === "completed_with_warnings" || document.needsOcrPageCount > 0;
          let statusLabel = "";
          if (document.status === "queued") statusLabel = t("projectDocuments.statusQueued");
          else if (document.status === "running") statusLabel = t("projectDocuments.statusRunning");
          else if (document.status === "failed") statusLabel = t("projectDocuments.statusFailed");
          else if (document.needsOcrPageCount > 0) statusLabel = t("projectDocuments.statusNeedsOcr", { count: document.needsOcrPageCount });
          else if (document.status === "completed_with_warnings") statusLabel = locale.startsWith("zh") ? "需留意" : "Needs attention";
          return (
            <div key={id} className={styles.row} data-active={id === activeSourceId}>
              <button type="button" className={styles.open} onClick={() => onOpenSource?.(target)}
                disabled={!onOpenSource} aria-current={id === activeSourceId ? "true" : undefined}
                title={document.filename}>
                <span className={styles.icon}>{getFileIcon(document.filename, 16)}</span>
                <span className={styles.label}>
                  <span className={styles.title}>{displayName}</span>
                  {(metadata.some(Boolean) || statusLabel) && <span className={styles.metadata} title={[...metadata, statusLabel].filter(Boolean).join(" · ")}>
                    <span className={styles.fileInfo}>{metadata.filter(Boolean).join(" · ")}</span>
                    {statusLabel && <span className={styles.status} data-attention={attention} data-failed={document.status === "failed"}>
                      {attention && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M12 3 2 21h20L12 3Z" strokeLinejoin="round" /><path d="M12 9v5m0 3v1" />
                      </svg>}
                      {statusLabel}
                    </span>}
                  </span>}
                </span>
              </button>
              <Popover.Root onOpenChange={() => { setSourceAction(null); setActionError(null); }}>
                <Popover.Trigger className={styles.more} aria-label={t("projectDocuments.details")} title={t("projectDocuments.details")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                  </svg>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner positionMethod="fixed" side="bottom" align="end" sideOffset={4} collisionPadding={8} className={styles.positioner}>
                    <Popover.Popup className={styles.popup} aria-label={document.filename}>
                      {!sourceAction ? <>
                        <button className={styles.menuItem} type="button" onClick={() => setSourceAction("remove")}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" strokeLinejoin="round" /></svg>
                          {locale.startsWith("zh") ? "移除来源" : "Remove source"}
                        </button>
                        <button className={styles.menuItem} type="button" onClick={() => { setSourceName(displayName); setSourceAction("rename"); }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z" strokeLinejoin="round" /></svg>
                          {locale.startsWith("zh") ? "重命名来源" : "Rename source"}
                        </button>
                      </> : <form className={styles.actionForm} onSubmit={(event) => { event.preventDefault(); void saveSourceAction(document); }}>
                        {sourceAction === "rename" ? <label>
                          {locale.startsWith("zh") ? "显示名称" : "Display name"}
                          <input aria-label={locale.startsWith("zh") ? "显示名称" : "Display name"} value={sourceName} onChange={(event) => setSourceName(event.target.value)} maxLength={200} required disabled={actionBusy} />
                        </label> : <p>{locale.startsWith("zh") ? "移除此来源？原文件会保留，此后不再用于项目提问。" : "Remove this source from future questions? The original file will be kept."}</p>}
                        {actionError && <p role="alert">{actionError}</p>}
                        <div className={styles.actionButtons}>
                          <button type="button" disabled={actionBusy} onClick={() => setSourceAction(null)}>{locale.startsWith("zh") ? "取消" : "Cancel"}</button>
                          <button type="submit" disabled={actionBusy || (sourceAction === "rename" && !sourceName.trim())}>
                            {actionBusy ? "…" : sourceAction === "rename" ? (locale.startsWith("zh") ? "保存" : "Save") : (locale.startsWith("zh") ? "移除" : "Remove")}
                          </button>
                        </div>
                      </form>}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
              <input className={styles.sourceCheckbox} type="checkbox"
                aria-label={(locale.startsWith("zh") ? "使用资料：" : "Use source: ") + document.filename}
                checked={selected.has(sourceSelectionKey(document))}
                disabled={!isSelectableSource(document) || loading || Boolean(error)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(sourceSelectionKey(document));
                  else next.delete(sourceSelectionKey(document));
                  onSelectionChange?.(project.root, [...next]);
                }} />
            </div>
          );
        })}
        </div>
      </div>}
      {project && <p className={styles.selectionFooter} role="status">
        <span>{locale.startsWith("zh") ? "已选 " : "Selected "}{selected.size} / {available.length}</span>
        <span className={styles.footerNote}>{locale.startsWith("zh") ? "下次提问生效" : "Applies to next question"}</span>
        {selected.size === 0 && available.length > 0 && <span className={styles.selectionHint}>
          {locale.startsWith("zh") ? "未选择资料：下次提问不使用项目来源检索" : "No project sources will be searched"}
        </span>}
      </p>}
    </section>
  );
}
