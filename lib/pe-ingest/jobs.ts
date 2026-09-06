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
  return job;
}

export function readPeIngestJobFile(target: string): PeIngestJob {
  const job = parsePeIngestJob(readFileSync(target, "utf8"));
  if (path.basename(target) !== `${job.jobId}.json`) throw new Error("Ingest job filename does not match its ID");
  return job;
}

export function findActivePeIngestJob(paths: PeProjectPaths): PeIngestJob | null {
  if (!existsSync(paths.jobDirectory)) return null;
  const candidates = readdirSync(paths.jobDirectory)
    .filter((name) => /^[a-f0-9]{16}\.json$/u.test(name))
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      const job = parsePeIngestJob(readFileSync(path.join(paths.jobDirectory, name), "utf8"));
      if (job.datasetId === paths.datasetId && PE_INGEST_ACTIVE_STATUSES.has(job.status)) return job;
    } catch {
      // Damaged files are not active-job authorities.
    }
  }
  return null;
}

export function newPeIngestJob(datasetId: string): PeIngestJob {
  return {
    jobId: randomBytes(8).toString("hex"),
    datasetId,
    status: "queued",
    message: "PDF 已上传，等待解析。",
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
    const completedFiles = new Set(current.result.files.map((file) => file.originalFilename));
    const pendingFiles = current.files.filter((file) => !completedFiles.has(file.originalFilename));
    const failed: PeIngestJob = {
      ...current,
      status: "failed",
      message,
      finishedAt: new Date().toISOString(),
      result: {
        ...current.result,
        failedCount: current.result.failedCount + pendingFiles.length,
        files: [
          ...current.result.files,
          ...pendingFiles.map((file) => ({
            originalFilename: file.originalFilename,
            status: "failed" as const,
            error: message,
          })),
        ],
      },
    };
    try {
      updatePeIngestJob(paths, failed);
    } catch {
      // The API can still report the queued status file if both stores are unavailable.
    }
  };
  child.once("error", (error) => recordSpawnFailure(error.message));
  child.once("exit", (code) => {
    if (code !== null && code !== 0) recordSpawnFailure(`PE ingest worker exited with code ${code}`);
  });
  child.unref();
}
