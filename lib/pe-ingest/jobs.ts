import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PeIngestJob, PeIngestStatus } from "./contracts.ts";
import type { PeProjectPaths } from "./paths.ts";
import { savePeIngestJobToDatabase } from "./repository.ts";
import { assertPeCollectionDataset, openPeCollectionDatabase } from "./schema.ts";

export const PE_INGEST_ACTIVE_STATUSES = new Set<PeIngestStatus>(["queued", "running"]);
export const PE_INGEST_SUCCESS_STATUSES = new Set<PeIngestStatus>([
  "completed",
  "completed_with_warnings",
]);

function jobFile(paths: PeProjectPaths, jobId: string): string {
  if (!/^[a-f0-9]{16}$/u.test(jobId)) throw new Error("Invalid ingest job ID");
  return path.join(paths.jobDirectory, `${jobId}.json`);
}

function parsePeIngestJob(raw: string): PeIngestJob {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object") throw new Error("Invalid ingest job data");
  const job = value as Partial<PeIngestJob>;
  if (
    typeof job.jobId !== "string"
    || typeof job.datasetId !== "string"
    || typeof job.status !== "string"
    || typeof job.message !== "string"
    || !Array.isArray(job.files)
    || !Array.isArray(job.warnings)
    || !job.result
  ) {
    throw new Error("Invalid ingest job data");
  }
  return job as PeIngestJob;
}

function writeJobFile(target: string, job: PeIngestJob, exclusive: boolean): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { flag: "wx" });
  try {
    if (exclusive && existsSync(target)) throw new Error(`Ingest job already exists: ${job.jobId}`);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createPeIngestJob(paths: PeProjectPaths, job: PeIngestJob): string {
  const target = jobFile(paths, job.jobId);
  writeJobFile(target, job, true);
  try {
    savePeIngestJobToDatabase(paths, job);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
  return target;
}

export function updatePeIngestJob(paths: PeProjectPaths, job: PeIngestJob): void {
  writeJobFile(jobFile(paths, job.jobId), job, false);
  savePeIngestJobToDatabase(paths, job);
}

export function readPeIngestJob(paths: PeProjectPaths, jobId: string): PeIngestJob {
  const job = parsePeIngestJob(readFileSync(jobFile(paths, jobId), "utf8"));
  if (job.jobId !== jobId || job.datasetId !== paths.datasetId) {
    throw new Error("Ingest job does not belong to the selected dataset");
  }
  return reconcilePeIngestJob(paths, job);
}

export function failPeIngestJob(paths: PeProjectPaths, job: PeIngestJob, message: string): PeIngestJob {
  if (!PE_INGEST_ACTIVE_STATUSES.has(job.status)) return job;
  const finished = new Set(job.result.files.map((file) => file.originalFilename));
  const pending = job.files.filter((file) => !finished.has(file.originalFilename));
  job.result.files.push(...pending.map((file) => ({
    originalFilename: file.originalFilename,
    docId: file.docId,
    status: "failed" as const,
    error: message,
  })));
  job.result.failedCount += pending.length;
  job.status = "failed";
  job.message = message;
  job.finishedAt = new Date().toISOString();
  updatePeIngestJob(paths, job);
  return job;
}

function reconcilePeIngestJob(paths: PeProjectPaths, job: PeIngestJob): PeIngestJob {
  if (!PE_INGEST_ACTIVE_STATUSES.has(job.status)) return job;
  if (job.workerPid) {
    try {
      process.kill(job.workerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return failPeIngestJob(paths, job, "文档处理进程已退出，可以重试失败的 Excel。");
      }
    }
  }
  const lastActivity = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.createdAt);
  const timeout = job.workerPid ? 30 * 60_000 : 2 * 60_000;
  if (Number.isFinite(lastActivity) && Date.now() - lastActivity > timeout) {
    return failPeIngestJob(paths, job, "文档处理任务已超时，可以重试失败的 Excel。");
  }
  return job;
}

export function readPeIngestJobFile(target: string): PeIngestJob {
  const job = parsePeIngestJob(readFileSync(target, "utf8"));
  if (path.basename(target) !== `${job.jobId}.json`) throw new Error("Ingest job filename does not match its ID");
  return job;
}

export function findActivePeIngestJob(paths: PeProjectPaths): PeIngestJob | null {
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const candidates = (existsSync(paths.jobDirectory) ? readdirSync(paths.jobDirectory) : [])
    .filter((name) => /^[a-f0-9]{16}\.json$/u.test(name))
    .sort()
    .reverse();
  const active: PeIngestJob[] = [];
  for (const name of candidates) {
    try {
      const job = readPeIngestJob(paths, name.slice(0, -5));
      if (job.datasetId === paths.datasetId && PE_INGEST_ACTIVE_STATUSES.has(job.status)) active.push(job);
    } catch {
      // Damaged files are not active-job authorities.
    }
  }
  recoverOrphanedExcelDocuments(paths, active);
  return active[0] ?? null;
}

function recoverOrphanedExcelDocuments(paths: PeProjectPaths, active: PeIngestJob[]): void {
  const activeDocIds = new Set(active.flatMap((job) => job.files.flatMap((file) => file.docId ? [file.docId] : [])));
  const now = Date.now();
  const cutoff = new Date(now - 2 * 60_000).toISOString();
  const database = openPeCollectionDatabase(paths.collectionPath);
  try {
    // Registration and UI job creation are separate commits. Recover a server killed between
    // them, while preserving valid agent leases and UI jobs whose worker is still alive.
    database.exec("BEGIN IMMEDIATE");
    try {
      const orphans = database.prepare(`SELECT d.doc_id, d.warnings_json FROM documents d
        WHERE d.dataset_id = ? AND d.file_type IN ('xlsx', 'xlsm')
          AND d.status IN ('queued', 'processing') AND d.deleted_at IS NULL AND d.lifecycle_state = 'active'
          AND julianday(d.updated_at) < julianday(?)
          AND NOT EXISTS (SELECT 1 FROM processing_jobs p
            WHERE p.doc_id = d.doc_id AND p.status = 'processing' AND p.lease_expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM ingest_jobs j,
            json_tree(CASE WHEN json_valid(j.input_files_json) THEN j.input_files_json ELSE '[]' END) f
            WHERE j.dataset_id = d.dataset_id AND j.status IN ('queued', 'running')
              AND julianday(j.updated_at) >= julianday(?) AND f.key = 'docId' AND f.value = d.doc_id)
      `).all(paths.datasetId, cutoff, now, cutoff);
      const fail = database.prepare("UPDATE documents SET status='failed', warnings_json=?, updated_at=? WHERE doc_id=? AND dataset_id=?");
      for (const document of orphans) {
        if (activeDocIds.has(String(document.doc_id))) continue;
        let warnings: string[] = [];
        try {
          const value: unknown = JSON.parse(String(document.warnings_json));
          if (Array.isArray(value)) warnings = value.filter((item): item is string => typeof item === "string");
        } catch { /* Preserve the recovery message when old warning metadata is malformed. */ }
        warnings.push("文档处理未启动或进程已退出，可以重试解析。");
        fail.run(JSON.stringify([...new Set(warnings)]), new Date(now).toISOString(), document.doc_id, paths.datasetId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function newPeIngestJob(datasetId: string): PeIngestJob {
  return {
    jobId: randomBytes(8).toString("hex"),
    datasetId,
    status: "queued",
    message: "文档已上传，等待解析。",
    files: [],
    createdAt: new Date().toISOString(),
    result: {
      files: [],
      createdCount: 0,
      failedCount: 0,
    },
    warnings: [],
  };
}

function workerEntryPath(): string {
  const target = path.resolve(process.cwd(), "dist", "pe-ingest", "worker.mjs");
  if (!existsSync(target)) throw new Error(`PE ingest worker is missing: ${target}`);
  return target;
}

export function startPeIngestJob(paths: PeProjectPaths, job: PeIngestJob): void {
  const target = workerEntryPath();
  const targetJobFile = jobFile(paths, job.jobId);
  const child = spawn(
    process.execPath,
    [target, "--job-file", targetJobFile],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    },
  );
  job.workerPid = child.pid;
  job.heartbeatAt = new Date().toISOString();
  let spawnFailureRecorded = false;
  const recordSpawnFailure = (message: string) => {
    if (spawnFailureRecorded) return;
    spawnFailureRecorded = true;
    let current = job;
    try {
      current = readPeIngestJob(paths, job.jobId);
      if (!PE_INGEST_ACTIVE_STATUSES.has(current.status)) return;
    } catch {
      // Fall back to the initial queued job below.
    }
    try {
      failPeIngestJob(paths, current, message);
    } catch {
      // The API can still report the queued status file if both stores are unavailable.
    }
  };
  child.once("error", (error) => recordSpawnFailure(error.message));
  child.once("exit", (code, signal) => {
    if (code !== 0) recordSpawnFailure(`PE ingest worker exited: ${signal ?? code}`);
  });
  try {
    updatePeIngestJob(paths, job);
  } catch (error) {
    child.kill();
    throw error;
  }
  child.unref();
}
