import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { validateUploadFileNames } from "@/lib/file-upload";
import {
  findCanonicalPeProject,
  PE_UPLOAD_AUTO_CREATE_THRESHOLD,
} from "@/lib/pe-auto-project";
import {
  PE_SUPPORTED_EXTENSIONS,
  findActivePeIngestJob,
  identifyPeUploads,
  resolvePeProjectPaths,
  startPeIngestJob,
  writeQueuedPeIngestJob,
  type PeIdentifiedUploadItem,
  type PeIngestJob,
} from "@/lib/pe-ingest";
import {
  activatePeProject,
  createPeProject,
  getPeProject,
  listPeProjects,
  peProjectStorePaths,
} from "@/lib/pe-project-store";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import { isApiRequestAllowed } from "@/lib/request-security";

const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024;

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function queuedJob(project: PeProjectSummary): { job: PeIngestJob; paths: ReturnType<typeof resolvePeProjectPaths> } {
  const paths = resolvePeProjectPaths(project, peProjectStorePaths().registryPath);
  const activeJob = findActivePeIngestJob(paths);
  if (activeJob) throw new Error(`项目“${project.name}”已有资料处理任务正在运行`);
  const job: PeIngestJob = {
    jobId: crypto.randomBytes(8).toString("hex"),
    datasetId: paths.datasetId,
    status: "queued",
    message: "资料已归类，等待解析。",
    projectPath: paths.projectPath,
    createdAt: new Date().toISOString(),
  };
  writeQueuedPeIngestJob(paths, job);
  startPeIngestJob(paths, job, {
    datasetName: project.name,
    companyName: project.companyName,
    companyTicker: project.companyTicker,
  });
  return { job, paths };
}

async function uploadToExistingProject(
  project: PeProjectSummary,
  files: File[],
): Promise<PeIngestJob> {
  const paths = resolvePeProjectPaths(project, peProjectStorePaths().registryPath);
  const activeJob = findActivePeIngestJob(paths);
  if (activeJob) throw new Error("A research indexing job is already running for this project");
  fs.mkdirSync(paths.uploadsPath, { recursive: true });
  for (const file of files) {
    const target = path.join(paths.uploadsPath, file.name);
    const temporary = path.join(paths.uploadsPath, `.${file.name}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
    fs.renameSync(temporary, target);
  }
  return queuedJob(project).job;
}

async function handleGlobalUpload(files: File[]) {
  const store = peProjectStorePaths();
  const batchId = `upload_${crypto.randomBytes(10).toString("hex")}`;
  const batchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pe-upload-"));
  try {
    const manifestItems: Array<{ itemId: string; originalFilename: string; stagedPath: string }> = [];
    for (const file of files) {
      const itemId = `file_${crypto.randomBytes(10).toString("hex")}`;
      const stagedPath = path.join(batchDirectory, `${itemId}${path.extname(file.name).toLowerCase()}`);
      fs.writeFileSync(stagedPath, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
      manifestItems.push({ itemId, originalFilename: file.name, stagedPath });
    }
    const manifestPath = path.join(batchDirectory, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify({ batchId, items: manifestItems }, null, 2)}\n`, { flag: "wx" });
    const identification = await identifyPeUploads(manifestPath);
    const catalog = listPeProjects();
    const knownProjects = [...catalog.projects];
    const createdProjects: PeProjectSummary[] = [];
    const affectedProjects = new Map<string, PeProjectSummary>();
    const routed = new Map<string, { project: PeProjectSummary; items: PeIdentifiedUploadItem[] }>();
    const needsReview: Array<{ fileName: string; companyName: string; companyTicker: string; reason: string }> =
      identification.failed.map((item) => ({
      fileName: item.originalFilename,
      companyName: "",
      companyTicker: "",
      reason: item.error,
      }));

    for (const group of identification.groups) {
    let project = findCanonicalPeProject(group.identity, knownProjects);
    if (!project) {
      if (
        !group.identity.company_name
        || group.identity.company_confidence < PE_UPLOAD_AUTO_CREATE_THRESHOLD
      ) {
        for (const item of group.items) {
          needsReview.push({
            fileName: item.originalFilename,
            companyName: group.identity.company_name,
            companyTicker: group.identity.company_ticker,
            reason: "无法高置信度识别标的公司，资料已保留在待确认区，未强行创建项目。",
          });
        }
        continue;
      }
      project = createPeProject({
        name: group.identity.company_name,
        companyName: group.identity.company_name,
        companyTicker: group.identity.company_ticker,
      });
      knownProjects.push(project);
      createdProjects.push(project);
    }
    affectedProjects.set(project.datasetId, project);
    const existing = routed.get(project.datasetId);
    if (existing) existing.items.push(...group.items);
    else routed.set(project.datasetId, { project, items: [...group.items] });
    }

    const jobs: PeIngestJob[] = [];
    const duplicateFiles: string[] = [];
    for (const { project, items } of routed.values()) {
    const paths = resolvePeProjectPaths(project, store.registryPath);
    if (findActivePeIngestJob(paths)) {
      for (const item of items) {
        needsReview.push({
          fileName: item.originalFilename,
          companyName: item.identity.company_name,
          companyTicker: item.identity.company_ticker,
          reason: `项目“${project.name}”已有资料处理任务正在运行，请稍后重试。`,
        });
      }
      continue;
    }
    fs.mkdirSync(paths.uploadsPath, { recursive: true });
    let changed = false;
    for (const item of items) {
      const target = path.join(paths.uploadsPath, item.originalFilename);
      const sourceDigest = crypto.createHash("sha256").update(fs.readFileSync(item.stagedPath)).digest("hex");
      const duplicate = fs.existsSync(target)
        && crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") === sourceDigest;
      if (duplicate) {
        duplicateFiles.push(item.originalFilename);
        continue;
      }
      const temporary = path.join(paths.uploadsPath, `.${item.originalFilename}.${crypto.randomUUID()}.tmp`);
      fs.copyFileSync(item.stagedPath, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, target);
      changed = true;
    }
    if (changed) jobs.push(queuedJob(project).job);
    }

    const batchStatus = needsReview.length > 0
      ? jobs.length > 0 || duplicateFiles.length > 0 ? "processing_with_review" : "needs_review"
      : jobs.length > 0 ? "processing" : "completed";
    const result = {
      batchId,
      status: batchStatus,
      projects: [...affectedProjects.values()],
      createdProjects,
      jobs,
      needsReview,
      duplicateFiles,
    };
    if (catalog.activeDatasetId && knownProjects.some(
      (project) => project.datasetId === catalog.activeDatasetId,
    )) {
      activatePeProject(catalog.activeDatasetId);
    }
    return result;
  } finally {
    fs.rmSync(batchDirectory, { recursive: true, force: true });
  }
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const form = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    const datasetId = textField(form, "datasetId").trim();
    const files = form.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) return NextResponse.json({ error: "files are required" }, { status: 400 });
    const names = files.map((file) => file.name);
    const nameError = validateUploadFileNames(names);
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each research file must be 100MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Research uploads must total 300MB or less" }, { status: 413 });
    }
    const unsupported = names.filter((name) => !PE_SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()));
    if (unsupported.length > 0) {
      return NextResponse.json({ error: `Unsupported research file: ${unsupported[0]}` }, { status: 400 });
    }

    if (!datasetId) {
      return NextResponse.json(await handleGlobalUpload(files), { status: 202 });
    }
    const project = getPeProject(datasetId);
    const cwd = textField(form, "cwd").trim();
    if (cwd && fs.realpathSync(cwd) !== fs.realpathSync(project.root)) {
      return NextResponse.json({ error: "Project identity does not match cwd" }, { status: 409 });
    }
    const job = await uploadToExistingProject(project, files);
    return NextResponse.json({ job, project, autoCreated: false }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Research upload request is too large" }, { status: 413 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
