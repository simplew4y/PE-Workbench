import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isPeConsensusEnabled } from "@earendil-works/pe-boot";
import { lock } from "proper-lockfile";

export interface PeAnalysisProgress {
  stage: "claims" | "questions" | "consensus";
  document?: number;
  documents?: number;
  window?: number;
  windows?: number;
  doc_id?: string;
}

export interface PeAnalysisResult {
  status: "completed" | "partial" | "failed" | "skipped_no_model" | "skipped_disabled";
  errors: string[];
  coverage?: Record<string, unknown>;
  documents_scanned?: number;
  consensus_cards?: { cards: number; narrative_method: string };
}

interface PeAnalysisOptions {
  collectionPath: string;
  datasetId: string;
  docIds: string[];
  companyName?: string;
  ingestedAt?: string;
  signal?: AbortSignal;
  onProgress?: (event: PeAnalysisProgress) => void;
}

function pythonCommand(): string {
  const override = process.env.PE_INGEST_ANALYSIS_PYTHON?.trim() || process.env.PE_EXCEL_PYTHON?.trim();
  if (override) return override;
  const peBootRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pe-boot"))));
  const venv = path.join(peBootRoot, "python", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  for (const candidate of [venv, ...(process.platform === "win32" ? ["python"] : ["python3", "python"])]) {
    if (candidate === venv && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-c", "import sqlite3, sys; assert sys.version_info >= (3, 10)"], {
      timeout: 5000, windowsHide: true, stdio: "ignore",
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error("观点分析需要 Python 3.10+ 标准库；可设置 PE_INGEST_ANALYSIS_PYTHON。");
}

export function markPeAnalysisFailed(collectionPath: string, datasetId: string, message: string): void {
  const db = new DatabaseSync(collectionPath, { timeout: 10_000 });
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='pe_analysis_metadata'").get()) {
      db.prepare("UPDATE pe_analysis_metadata SET status='failed',error=?,finished_at=? WHERE dataset_id=? AND status='running'")
        .run(message.slice(0, 1000), new Date().toISOString(), datasetId);
    }
  } finally { db.close(); }
}

export async function runPeClaimAnalysis(options: PeAnalysisOptions): Promise<PeAnalysisResult> {
  if (!isPeConsensusEnabled() || process.env.PE_INGEST_ANALYSIS_DISABLED === "1") {
    return { status: "skipped_disabled", errors: [] };
  }
  if (!process.env.PE_INGEST_LLM_BASE_URL?.trim() || !process.env.PE_INGEST_LLM_API_KEY?.trim()) {
    return { status: "skipped_no_model", errors: [] };
  }
  const configuredTimeout = Number(process.env.PE_INGEST_ANALYSIS_TIMEOUT_SECONDS ?? 1800);
  const timeoutSeconds = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 1800;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal, AbortSignal.timeout(Math.min(2_147_483_647, Math.ceil(timeoutSeconds * 1000))),
    ...(options.signal ? [options.signal] : []),
  ]);
  const collectionPath = realpathSync(options.collectionPath);
  const lockPath = path.join(path.dirname(collectionPath), ".pe-analysis.lock");
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    signal.throwIfAborted();
    try {
      release = await lock(collectionPath, {
        lockfilePath: lockPath, stale: 60_000, update: 10_000, retries: 0,
        onCompromised: (error) => controller.abort(error),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      await delay(1000, undefined, { signal });
    }
  }
  try {
    signal.throwIfAborted();
    const script = fileURLToPath(new URL("../../services/pe-analysis/analyze_collection.py", import.meta.url));
    const command = pythonCommand();
    const result = await new Promise<PeAnalysisResult>((resolve, reject) => {
      const child = spawn(command, [
        "-u", script, "--collection-path", collectionPath, "--dataset-id", options.datasetId,
        "--doc-ids-json", JSON.stringify(options.docIds), "--company-name", options.companyName ?? "",
        "--ingested-at", options.ingestedAt ?? "", "--parent-stdio", "--timeout-seconds", String(timeoutSeconds),
      ], { cwd: path.dirname(script), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
      let stdout = "";
      let stderr = "";
      let pending = "";
      let termination: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: Error) => {
        if (termination) return;
        termination = error;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref();
      };
      const abort = () => stop(new Error(signal.reason instanceof Error ? signal.reason.message : "Analysis cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.on("error", () => { /* A terminated child closes the lifetime pipe. */ });
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 2_000_000) stop(new Error("Analysis result exceeded the output limit"));
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-32_000);
        pending += chunk;
        const lines = pending.split("\n");
        pending = (lines.pop() ?? "").slice(-32_000);
        for (const line of lines) {
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (event && event.kind === "progress" && ["claims", "questions", "consensus"].includes(String(event.stage))) {
            try { options.onProgress?.(event as unknown as PeAnalysisProgress); }
            catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
          }
        }
      });
      child.once("error", (error) => { termination = error; });
      child.once("close", (code, exitSignal) => {
        signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
        child.stdin.destroy();
        if (termination) { reject(termination); return; }
        if (code !== 0) {
          reject(new Error(`Analysis worker exited (${exitSignal ?? code}): ${stderr.slice(-1500)}`));
          return;
        }
        try {
          const payload: unknown = JSON.parse(stdout);
          if (!payload || typeof payload !== "object" || !("status" in payload)
            || !["completed", "partial", "failed", "skipped_no_model", "skipped_disabled"].includes(String(payload.status))) {
            throw new Error("Invalid analysis worker result");
          }
          resolve(payload as PeAnalysisResult);
        } catch (error) { reject(error); }
      });
    });
    return result;
  } catch (error) {
    try { markPeAnalysisFailed(collectionPath, options.datasetId, error instanceof Error ? error.message : String(error)); }
    catch { /* Retain the primary process error; document ingestion is already committed. */ }
    throw error;
  } finally {
    await release();
  }
}
