import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PeProjectSummary } from "./pe-project-types";

export const PE_SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".xlsx",
  ".xlsm",
  ".docx",
  ".pptx",
  ".csv",
  ".md",
  ".markdown",
  ".txt",
]);

export const PE_INGEST_ACTIVE_STATUSES = new Set(["queued", "running"]);
export const PE_INGEST_SUCCESS_STATUSES = new Set(["completed", "completed_with_warnings"]);

export interface PeIngestJob {
  jobId: string;
  datasetId: string;
  status: string;
  message: string;
  projectPath: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
}

export interface PeProjectPaths {
  projectPath: string;
  workspaceRoot: string;
  registryPath: string;
  datasetId: string;
  uploadsPath: string;
  jobDirectory: string;
}

export function resolvePeProjectPaths(
  project: Pick<PeProjectSummary, "datasetId" | "root">,
  registryPath: string,
): PeProjectPaths {
  const projectPath = fs.realpathSync(project.root);
  if (!fs.statSync(projectPath).isDirectory()) throw new Error("PE project path is not a directory");

  const directoryName = path.basename(projectPath);
  if (project.datasetId !== directoryName) {
    throw new Error("Registered dataset ID does not match its project directory");
  }

  const workspaceRoot = path.dirname(projectPath);
  const peWorkbenchRoot = path.dirname(workspaceRoot);
  const resolvedRegistry = fs.realpathSync(registryPath);
  if (resolvedRegistry !== path.join(peWorkbenchRoot, "datasets.sqlite3")) {
    throw new Error("PE project registry does not match the registered project root");
  }
  return {
    projectPath,
    workspaceRoot,
    registryPath: resolvedRegistry,
    datasetId: project.datasetId,
    uploadsPath: path.join(peWorkbenchRoot, "_uploads", project.datasetId),
    jobDirectory: path.join(projectPath, "meta", "ingest-ui-jobs"),
  };
}

function jobFile(paths: PeProjectPaths, jobId: string): string {
  if (!/^[a-f0-9]{16}$/u.test(jobId)) throw new Error("Invalid ingest job ID");
  return path.join(paths.jobDirectory, `${jobId}.json`);
}

export function readPeIngestJob(paths: PeProjectPaths, jobId: string): PeIngestJob {
  const raw = fs.readFileSync(jobFile(paths, jobId), "utf8");
  return JSON.parse(raw) as PeIngestJob;
}

export function findActivePeIngestJob(paths: PeProjectPaths): PeIngestJob | null {
  if (!fs.existsSync(paths.jobDirectory)) return null;
  const candidates = fs.readdirSync(paths.jobDirectory)
    .filter((name) => /^[a-f0-9]{16}\.json$/u.test(name))
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(paths.jobDirectory, name), "utf8")) as PeIngestJob;
      if (PE_INGEST_ACTIVE_STATUSES.has(job.status)) return job;
    } catch {
      // A temporary or damaged status file is not an active-job authority.
    }
  }
  return null;
}

export function writeQueuedPeIngestJob(paths: PeProjectPaths, job: PeIngestJob): string {
  fs.mkdirSync(paths.jobDirectory, { recursive: true });
  const target = jobFile(paths, job.jobId);
  fs.writeFileSync(target, `${JSON.stringify(job, null, 2)}\n`, { flag: "wx" });
  return target;
}

function serviceRoot(): string {
  return path.join(process.cwd(), "services", "pe-ingest");
}

function pythonExecutable(root: string): string {
  const configured = process.env.PE_INGEST_PYTHON?.trim();
  if (configured) return configured;
  const virtualEnvironmentPython = path.join(root, ".venv", "bin", "python");
  return fs.existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : "python3";
}

export function startPeIngestJob(
  paths: PeProjectPaths,
  job: PeIngestJob,
  options: { datasetName?: string; companyName?: string; companyTicker?: string },
): void {
  const root = serviceRoot();
  const runner = path.join(root, "run_job.py");
  if (!fs.existsSync(runner)) throw new Error(`PE ingest runner is missing: ${runner}`);

  const args = [
    runner,
    "--directory",
    paths.uploadsPath,
    "--workspace-root",
    paths.workspaceRoot,
    "--project-root",
    paths.projectPath,
    "--registry-path",
    paths.registryPath,
    "--dataset-id",
    paths.datasetId,
    "--dataset-name",
    options.datasetName?.trim() || paths.datasetId,
    "--company-name",
    options.companyName?.trim() || "",
    "--company-ticker",
    options.companyTicker?.trim() || "",
    "--job-id",
    job.jobId,
    "--job-file",
    jobFile(paths, job.jobId),
  ];

  const child = spawn(pythonExecutable(root), args, {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  child.once("error", (error) => {
    const failed: PeIngestJob = {
      ...job,
      status: "failed",
      message: error.message,
      finishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(jobFile(paths, job.jobId), `${JSON.stringify(failed, null, 2)}\n`);
  });
  child.unref();
}
