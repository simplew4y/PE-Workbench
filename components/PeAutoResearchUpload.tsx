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
  onProjectsChanged: (projects: PeProjectSummary[]) => void;
  onComplete?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

const SUPPORTED_SUFFIXES = new Set([
  "pdf", "xlsx", "xlsm", "docx", "pptx", "csv", "md", "markdown", "txt",
]);

interface GlobalUploadResult {
  jobs: IngestJob[];
  projects: PeProjectSummary[];
  createdProjects: PeProjectSummary[];
  needsReview: Array<{ fileName: string; reason: string }>;
  duplicateFiles: string[];
}

function upload(files: File[], onProgress: (progress: number) => void): Promise<GlobalUploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    const request = new XMLHttpRequest();
    request.open("POST", "/api/pe/ingest");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onerror = () => reject(new Error("Network error while uploading research files"));
    request.onabort = () => reject(new Error("Research upload cancelled"));
    request.onload = () => {
      let body: Partial<GlobalUploadResult> & { error?: string } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        // The HTTP status supplies the fallback error below.
      }
      if (
        request.status < 200 || request.status >= 300
        || !Array.isArray(body.jobs) || !Array.isArray(body.projects)
        || !Array.isArray(body.createdProjects) || !Array.isArray(body.needsReview)
        || !Array.isArray(body.duplicateFiles)
      ) {
        reject(new Error(body.error ?? `Research upload failed (HTTP ${request.status})`));
        return;
      }
      resolve(body as GlobalUploadResult);
    };
    request.send(form);
  });
}

export function PeAutoResearchUpload({ onProjectsChanged, onComplete, onBusyChange }: Props) {
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
    if (selected.length === 0 || busy) return;
    const unsupported = selected.find((file) => {
      const suffix = file.name.split(".").pop()?.toLowerCase() ?? "";
      return !SUPPORTED_SUFFIXES.has(suffix);
    });
    if (unsupported) {
      setStage("failed");
      setMessage(t("files.researchUnsupported"));
      return;
    }

    void (async () => {
      setProgress(0);
      setStage("uploading");
      setMessage(t("autoUpload.uploading"));
      try {
        const result = await upload(selected, setProgress);
        if (!mountedRef.current) return;
        onProjectsChanged(result.projects);
        setProgress(100);
        let jobs = result.jobs;
        while (jobs.some((job) => ["queued", "running"].includes(job.status))) {
          setStage(jobs.some((job) => job.status === "running") ? "running" : "queued");
          setMessage(t("autoUpload.researchingProjects", { count: jobs.length }));
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          if (!mountedRef.current) return;
          jobs = await Promise.all(jobs.map(async (job) => {
            if (!["queued", "running"].includes(job.status)) return job;
            const response = await fetch(
              `/api/pe/ingest/${encodeURIComponent(job.jobId)}?${new URLSearchParams({ datasetId: job.datasetId }).toString()}`,
              { cache: "no-store" },
            );
            const body = await response.json().catch(() => ({})) as { job?: IngestJob; error?: string };
            if (!response.ok || !body.job) {
              throw new Error(body.error ?? `Pipeline status failed (HTTP ${response.status})`);
            }
            return body.job;
          }));
        }
        const failedJob = jobs.find(
          (job) => job.status !== "completed" && job.status !== "completed_with_warnings",
        );
        if (failedJob) {
          throw new Error(failedJob.message || t("files.researchFailed"));
        }
        const warning = result.needsReview.length > 0
          || jobs.some((job) => job.status === "completed_with_warnings");
        setStage(warning ? "warning" : "completed");
        setMessage(result.needsReview.length > 0
          ? t("autoUpload.needsReview", { count: result.needsReview.length })
          : t("autoUpload.completeProjects", { count: result.projects.length }));
        onComplete?.();
      } catch (cause) {
        if (!mountedRef.current) return;
        setStage("failed");
        setMessage(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [busy, onComplete, onProjectsChanged, t]);

  return (
    <div style={{ marginTop: 10 }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.xlsx,.xlsm,.docx,.pptx,.csv,.md,.markdown,.txt"
        onChange={handleFiles}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
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
          color: "var(--accent)",
          cursor: busy ? "wait" : "pointer",
          fontSize: 12,
          fontWeight: 650,
          opacity: busy ? 0.75 : 1,
        }}
        title={t("autoUpload.title")}
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
        {busy ? t("autoUpload.busy") : t("autoUpload.action")}
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
      <div style={{ marginTop: 5, color: "var(--text-dim)", fontSize: 10, lineHeight: 1.4 }}>
        {t("autoUpload.hint")}
      </div>
    </div>
  );
}
