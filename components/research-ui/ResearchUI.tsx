"use client";

import { useId, useRef, type ReactNode } from "react";
import styles from "./research-ui.module.css";

export type ConfirmationStatus = "draft" | "pending" | "confirmed" | "error" | "stale";

/** Controlled presentation only. The host owns persistence and execution. */
export function FrameworkConfirmation({ status, onConfirm, error, preview }: {
  status: ConfirmationStatus;
  onConfirm: () => void;
  error?: string;
  preview?: ReactNode;
}) {
  const labels: Record<ConfirmationStatus, string> = {
    draft: "确定投资框架", pending: "正在确认…", confirmed: "已确定投资框架",
    error: "重试确认", stale: "此草稿已有更新",
  };
  return <div className={styles.confirmation}>
    <button className={styles.confirm} type="button" disabled={status !== "draft" && status !== "error"}
      onClick={onConfirm} aria-busy={status === "pending"}>{labels[status]}</button>
    <span className={styles.status} role="status">{status === "confirmed" ? "已保存为正式研究基准" : status === "stale" ? "请在对话中查看最新提案。" : ""}</span>
    {status === "error" && <p role="alert">{error || "未能确认，草稿已保留，请重试。"}</p>}
    {preview && status !== "confirmed" && <details><summary>查看待确认内容</summary>{preview}</details>}
  </div>;
}

export interface ResearchArtifact {
  id: string;
  label: string;
  icon?: ReactNode;
  subtitle?: string;
  content: ReactNode;
  actions?: ReactNode;
}

/** IDs are unique within one rail. A null selection collapses the reader. */
export function ResearchRail({ artifacts, selectedId, onSelect }: {
  artifacts: readonly ResearchArtifact[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const prefix = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selected = artifacts.find((artifact) => artifact.id === selectedId);
  const close = () => { onSelect(null); if (selected) buttons.current.get(selected.id)?.focus(); };
  return <aside className={styles.rail} aria-label="研究成果">
    {selected && <section className={styles.panel} role="tabpanel" id={`${prefix}-panel-${selected.id}`}
      aria-labelledby={`${prefix}-tab-${selected.id}`} tabIndex={0}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header><div><strong>{selected.label}</strong><small>{selected.subtitle}</small></div>
        <button type="button" aria-label="收起研究成果" onClick={close}>×</button></header>
      {selected.actions && <div className={styles.actions}>{selected.actions}</div>}
      <div className={styles.content}>{selected.content}</div>
      <footer>想调整内容？直接在对话中告诉 Agent。</footer>
    </section>}
    <div className={styles.tabs} role="tablist" aria-label="成果类型" aria-orientation="vertical">
      {artifacts.map((artifact, index) => <button key={artifact.id} type="button" role="tab"
        ref={(element) => { if (element) buttons.current.set(artifact.id, element); else buttons.current.delete(artifact.id); }}
        id={`${prefix}-tab-${artifact.id}`} aria-selected={selected?.id === artifact.id}
        aria-controls={selected?.id === artifact.id ? `${prefix}-panel-${artifact.id}` : undefined}
        tabIndex={selected ? (selected.id === artifact.id ? 0 : -1) : (index === 0 ? 0 : -1)}
        onClick={() => onSelect(selected?.id === artifact.id ? null : artifact.id)}
        onKeyDown={(event) => {
          const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
          const next = event.key === "Home" ? 0 : event.key === "End" ? artifacts.length - 1 : (index + offset + artifacts.length) % artifacts.length;
          if (!offset && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          onSelect(artifacts[next].id);
          buttons.current.get(artifacts[next].id)?.focus();
        }}><span aria-hidden="true">{artifact.icon}</span><span>{artifact.label}</span></button>)}
    </div>
  </aside>;
}

/** Version browsing never changes which version is formally published. */
export function ArtifactVersions({ versions, selectedId, onSelect }: {
  versions: readonly { id: string; label: string }[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const index = versions.findIndex((version) => version.id === selectedId);
  return <nav className={styles.versions} aria-label="成果版本">
    <button type="button" aria-label="上一版本" disabled={index <= 0} onClick={() => onSelect(versions[index - 1].id)}>←</button>
    <span aria-live="polite">{versions[index]?.label ?? "暂无版本"}</span>
    <button type="button" aria-label="下一版本" disabled={index < 0 || index >= versions.length - 1} onClick={() => onSelect(versions[index + 1].id)}>→</button>
  </nav>;
}
