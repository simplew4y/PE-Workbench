import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  rawPath: string;
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
    rawPath: path.join(projectPath, "raw"),
    jobDirectory: path.join(projectPath, "meta", "ingest-ui-jobs"),
  };
}

export function writePeRawFile(
  rawPath: string,
  filename: string,
  content: Buffer,
): { path: string; duplicate: boolean } {
  fs.mkdirSync(rawPath, { recursive: true });
  const digest = createHash("sha256").update(content).digest("hex");
  const parsed = path.parse(filename);
  const candidates = [
    path.join(rawPath, filename),
    path.join(rawPath, `${parsed.name}_${digest.slice(0, 8)}${parsed.ext}`),
    path.join(rawPath, `${parsed.name}_${digest}${parsed.ext}`),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      const temporary = path.join(rawPath, `.${path.basename(candidate)}.${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, content, { flag: "wx" });
      try {
        fs.linkSync(temporary, candidate);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return { path: candidate, duplicate: false };
    }
    const existingDigest = createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
    if (existingDigest === digest) return { path: candidate, duplicate: true };
  }

  throw new Error(`Unable to allocate a collision-safe raw filename for ${filename}`);
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

export interface PeUploadIdentity {
  company_name: string;
  company_ticker: string;
  company_confidence: number;
  ticker_confidence: number;
  method: string;
}

export interface PeIdentifiedUploadItem {
  itemId: string;
  originalFilename: string;
  stagedPath: string;
  identity: PeUploadIdentity;
}

export interface PeUploadIdentification {
  groups: Array<{ identity: PeUploadIdentity; items: PeIdentifiedUploadItem[] }>;
  failed: Array<{ itemId: string; originalFilename: string; stagedPath: string; error: string }>;
}

export function parsePeUploadIdentificationOutput(stdout: string): PeUploadIdentification {
  const jsonLine = stdout.trim().split(/\r?\n/u).reverse().find(
    (line) => line.trimStart().startsWith("{"),
  );
  if (!jsonLine) throw new Error("PE upload identifier returned invalid JSON");
  return JSON.parse(jsonLine) as PeUploadIdentification;
}

export function identifyPeUploads(manifestPath: string): Promise<PeUploadIdentification> {
  const root = serviceRoot();
  const identifier = path.join(root, "identify_uploads.py");
  if (!fs.existsSync(identifier)) throw new Error(`PE upload identifier is missing: ${identifier}`);
  return new Promise((resolve, reject) => {
    execFile(
      pythonExecutable(root),
      [identifier, manifestPath],
      { cwd: root, env: { ...process.env, PYTHONUNBUFFERED: "1" }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(parsePeUploadIdentificationOutput(stdout));
        } catch {
          reject(new Error("PE upload identifier returned invalid JSON"));
        }
      },
    );
  });
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
    paths.rawPath,
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
