"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PeProjectSummary } from "@/lib/pe-project-types";

type UploadStage = "idle" | "uploading" | "queued" | "running" | "completed" | "warning" | "failed";

interface IngestJob {
  jobId: string;
  datasetId: string;
  status: string;
  message: string;
}

interface Props {
  project?: PeProjectSummary;
  onComplete?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDocumentsChanged?: () => void;
}

function upload(
  datasetId: string,
  files: File[],
  onProgress: (progress: number) => void,
): Promise<IngestJob> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("datasetId", datasetId);
    files.forEach((file) => form.append("files", file, file.name));
    const request = new XMLHttpRequest();
    request.open("POST", "/api/pe/ingest");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onerror = () => reject(new Error("Network error while uploading documents"));
    request.onabort = () => reject(new Error("Document upload cancelled"));
    request.onload = () => {
      let body: { job?: IngestJob; error?: string } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        // The HTTP status supplies the fallback error below.
      }
      if (request.status < 200 || request.status >= 300 || !body.job) {
        reject(new Error(body.error ?? `Document upload failed (HTTP ${request.status})`));
        return;
      }
      resolve(body.job);
    };
    request.send(form);
  });
}

export function PeResearchUpload({ project, onComplete, onBusyChange, onDocumentsChanged }: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const busy = stage === "uploading" || stage === "queued" || stage === "running";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const handleFiles = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0 || busy || !project) return;
    const unsupported = selected.find((file) => (
      !/\.(pdf|xlsx|xlsm)$/iu.test(file.name)
    ));
    if (unsupported) {
      setStage("failed");
      setMessage(t("files.researchUnsupported"));
      return;
    }

    const datasetId = project.datasetId;
    void (async () => {
      setProgress(0);
      setStage("uploading");
      setMessage(t("researchUpload.uploading"));
      try {
        let job = await upload(datasetId, selected, setProgress);
        if (!mountedRef.current) return;
        onDocumentsChanged?.();
        setProgress(100);
        while (job.status === "queued" || job.status === "running") {
          setStage(job.status);
          setMessage(job.message || t("researchUpload.running"));
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          if (!mountedRef.current) return;
          const response = await fetch(
            `/api/pe/ingest/${encodeURIComponent(job.jobId)}?${new URLSearchParams({ datasetId }).toString()}`,
            { cache: "no-store" },
          );
          const body = await response.json().catch(() => ({})) as { job?: IngestJob; error?: string };
          if (!response.ok || !body.job) {
            throw new Error(body.error ?? `Pipeline status failed (HTTP ${response.status})`);
          }
          job = body.job;
        }
        if (job.status !== "completed" && job.status !== "completed_with_warnings") {
          throw new Error(job.message || t("files.researchFailed"));
        }
        setStage(job.status === "completed" ? "completed" : "warning");
        setMessage(job.message || t("files.researchComplete"));
        onComplete?.();
      } catch (cause) {
        if (!mountedRef.current) return;
        onDocumentsChanged?.();
        setStage("failed");
        setMessage(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [busy, onComplete, onDocumentsChanged, project, t]);

  const disabled = busy || !project;
  return (
    <div style={{ marginTop: 10 }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept="application/pdf,.pdf,.xlsx,.xlsm"
        onChange={handleFiles}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        style={{
          width: "100%",
          minHeight: 38,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          border: "1px solid rgba(37,99,235,0.4)",
          borderRadius: 7,
          background: "rgba(37,99,235,0.08)",
          color: project ? "var(--accent)" : "var(--text-dim)",
          cursor: busy ? "wait" : project ? "pointer" : "not-allowed",
          fontSize: 12,
          fontWeight: 650,
          opacity: disabled ? 0.65 : 1,
        }}
        title={project ? t("researchUpload.title") : t("researchUpload.noProject")}
      >
        {busy ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-5.7-8.4" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 20h14" />
          </svg>
        )}
        {busy ? t("researchUpload.busy") : t("researchUpload.action")}
      </button>
      {stage !== "idle" && (
        <div
          role={stage === "failed" ? "alert" : "status"}
          aria-live="polite"
          style={{ marginTop: 7, color: stage === "failed" ? "#ef4444" : stage === "warning" ? "#f59e0b" : "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}
        >
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <span style={{ flex: 1, overflowWrap: "anywhere" }}>{message}</span>
            {!busy && (
              <button type="button" onClick={() => setStage("idle")} style={{ border: 0, padding: 0, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }} aria-label={t("files.dismissUploadResults")}>×</button>
            )}
          </div>
          {stage === "uploading" && (
            <div style={{ height: 3, marginTop: 5, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "var(--accent)", transition: "width 120ms ease" }} />
            </div>
          )}
        </div>
      )}
      {!project && (
        <div style={{ marginTop: 5, color: "var(--text-dim)", fontSize: 10, lineHeight: 1.4 }}>
          {t("researchUpload.noProject")}
        </div>
      )}
    </div>
  );
}
