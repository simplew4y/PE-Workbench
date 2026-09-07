import path from "node:path";
import { registerPeDocuments } from "@earendil-works/pe-boot/documents";
import { lockSync } from "proper-lockfile";
import type { PeProjectSummary } from "../pe-project-types.ts";
import type { PeIngestJob } from "./contracts.ts";
import {
  createPeIngestJob,
  failPeIngestJob,
  findActivePeIngestJob,
  newPeIngestJob,
  readPeIngestJob,
  startPeIngestJob,
} from "./jobs.ts";
import {
  hasPeRawFilename,
  normalizePePdfFilename,
  pePdfFilenameKey,
  resolvePeProjectPaths,
  sha256,
  writePeRawFile,
} from "./paths.ts";
import { findPeDocumentByFilename, findPeDocumentByHash, registeredPePdfInput } from "./repository.ts";
import { assertPeCollectionDataset, openPeCollectionDatabase } from "./schema.ts";

export const PE_SUPPORTED_EXTENSIONS = new Set([".pdf", ".xlsx", ".xlsm"]);
export const PE_PDF_MIME_TYPE = "application/pdf";

export interface PePdfUpload {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface QueuePePdfIngestOptions {
  project: PeProjectSummary;
  registryPath: string;
  uploads: PePdfUpload[];
}

export function validatePePdfUpload(upload: PePdfUpload): string | null {
  try {
    normalizePePdfFilename(upload.filename);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (upload.mimeType.toLocaleLowerCase() !== PE_PDF_MIME_TYPE) {
    return `Invalid PDF MIME type for ${upload.filename}`;
  }
  if (upload.content.subarray(0, 5).toString("ascii") !== "%PDF-") {
    return `Invalid PDF file header: ${upload.filename}`;
  }
  return null;
}

export function queuePePdfIngest(options: QueuePePdfIngestOptions): PeIngestJob {
  const paths = resolvePeProjectPaths(options.project, options.registryPath);
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const release = acquireSubmissionLock(paths);
  const job = newPeIngestJob(paths.datasetId);
  try {
    const active = findActivePeIngestJob(paths);
    if (active) throw new Error(`项目“${options.project.name}”已有文档处理任务正在运行`);
    const normalizedUploads = options.uploads.map((upload) => ({
      ...upload,
      filename: path.extname(upload.filename).toLowerCase() === ".pdf"
        ? normalizePePdfFilename(upload.filename) : upload.filename,
    }));
    const queuedNames = new Set<string>();
    const queuedDigests = new Map<string, string>();

    for (const upload of normalizedUploads) {
      const validationError = validatePeResearchUpload(upload);
      if (validationError) throw new Error(validationError);
      if (path.extname(upload.filename).toLowerCase() !== ".pdf") {
        const key = `excel:${upload.filename}`;
        if (queuedNames.has(key)) throw new Error(`Duplicate Excel filename in upload: ${upload.filename}`);
        queuedNames.add(key);
        continue;
      }
      const nameKey = pePdfFilenameKey(upload.filename);
      if (queuedNames.has(nameKey)) {
        throw new Error(`Duplicate PDF filename in upload: ${upload.filename}`);
      }
      queuedNames.add(nameKey);
      const existingByName = findPeDocumentByFilename(
        paths.collectionPath,
        paths.datasetId,
        upload.filename,
      );
      if (existingByName || hasPeRawFilename(paths, upload.filename)) {
        throw new Error(`PDF filename already exists in this project: ${upload.filename}`);
      }
      const digest = sha256(upload.content);
      const existing = findPeDocumentByHash(paths.collectionPath, paths.datasetId, digest);
      if (existing) {
        throw new Error(`The same PDF content already exists as ${existing.originalFilename}`);
      }
      const queuedFilename = queuedDigests.get(digest);
      if (queuedFilename) {
        throw new Error(`The same PDF content was selected twice: ${queuedFilename}, ${upload.filename}`);
      }
      queuedDigests.set(digest, upload.filename);
    }

    const excelUploads = normalizedUploads.filter((upload) => path.extname(upload.filename).toLowerCase() !== ".pdf");
    if (excelUploads.length > 0) {
      const registered = registerPeDocuments(paths.projectPath, paths.datasetId, excelUploads.map((upload) => ({
        name: upload.filename, bytes: upload.content,
      })));
      for (const document of registered.documents) {
        job.files.push({
          originalFilename: String(document.original_filename),
          rawPath: String(document.raw_path),
          sha256: String(document.sha256),
          docId: String(document.doc_id),
          fileType: document.file_type as "xlsx" | "xlsm",
        });
      }
    }
    for (const upload of normalizedUploads.filter((entry) => path.extname(entry.filename).toLowerCase() === ".pdf")) {
      const raw = writePeRawFile(paths, upload.filename, upload.content);
      job.files.push({
        originalFilename: upload.filename,
        rawPath: raw.rawPath,
        sha256: raw.sha256,
        fileType: "pdf",
      });
    }

    return launchJob(paths, job);
  } catch (error) {
    if (job.files.length > 0) failSavedUploads(paths, job, error);
    throw error;
  } finally {
    release();
  }
}

export function validatePeResearchUpload(upload: PePdfUpload): string | null {
  const extension = path.extname(upload.filename).toLowerCase();
  if (extension === ".pdf") return validatePePdfUpload(upload);
  if (!PE_SUPPORTED_EXTENSIONS.has(extension)) return `Unsupported research file: ${upload.filename}`;
  if (!upload.filename || path.basename(upload.filename) !== upload.filename || /[\\/\u0000-\u001f]/u.test(upload.filename)) {
    return "Invalid Excel file name";
  }
  const accepted = new Set(["", "application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel.sheet.macroenabled.12"]);
  if (!accepted.has(upload.mimeType.toLowerCase())) return `Invalid Excel MIME type: ${upload.filename}`;
  // Registration validates the ZIP members and OOXML workbook content types before storing raw bytes.
  if (upload.content.length < 4 || upload.content.readUInt32LE(0) !== 0x04034b50) {
    return `Invalid Excel OOXML package: ${upload.filename}`;
  }
  return null;
}

export function queuePeDocumentRetry(project: PeProjectSummary, registryPath: string, docId: string): PeIngestJob {
  const paths = resolvePeProjectPaths(project, registryPath);
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const release = acquireSubmissionLock(paths);
  try {
    if (findActivePeIngestJob(paths)) throw new Error("项目已有文档处理任务正在运行");
    const database = openPeCollectionDatabase(paths.collectionPath);
    try {
      const document = database.prepare(`SELECT doc_id, original_filename, raw_path, sha256, file_type
        FROM documents WHERE doc_id = ? AND dataset_id = ?
          AND (file_type IN ('xlsx', 'xlsm') OR (file_type = 'pdf' AND registration_kind = 'catalog'))
          AND deleted_at IS NULL AND lifecycle_state = 'active'`).get(docId, paths.datasetId);
      if (!document) throw new Error("Retryable document not found");
      const job = newPeIngestJob(paths.datasetId);
      job.files.push(document.file_type === "pdf" ? registeredPePdfInput(paths, docId) : {
        originalFilename: String(document.original_filename), rawPath: String(document.raw_path),
        sha256: String(document.sha256), docId: String(document.doc_id), fileType: document.file_type as "xlsx" | "xlsm",
      });
      return launchJob(paths, job);
    } finally {
      database.close();
    }
  } finally {
    release();
  }
}

// Retain the existing Excel service export for callers upgrading alongside Core.
export const queuePeExcelRetry = queuePeDocumentRetry;

function launchJob(paths: ReturnType<typeof resolvePeProjectPaths>, job: PeIngestJob): PeIngestJob {
  try {
    createPeIngestJob(paths, job);
    startPeIngestJob(paths, job);
  } catch (error) {
    failSavedUploads(paths, job, error);
    throw error;
  }
  return job;
}

function acquireSubmissionLock(paths: ReturnType<typeof resolvePeProjectPaths>): () => void {
  try {
    // The lock covers admission, original registration, and durable job creation across server processes.
    return lockSync(paths.collectionPath, {
      lockfilePath: path.join(paths.metaPath, ".ingest-submit.lock"),
      stale: 5 * 60_000,
      retries: 0,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error("项目已有文档处理任务正在运行，请稍后重试");
    }
    throw error;
  }
}

function failSavedUploads(paths: ReturnType<typeof resolvePeProjectPaths>, job: PeIngestJob, error: unknown): void {
  if (job.status === "failed") return;
  const message = error instanceof Error ? error.message : String(error);
  // Registration has already committed the current version. Keep it visible and retryable even
  // if a later PDF write or worker launch fails before an ingest job has been created.
  const database = openPeCollectionDatabase(paths.collectionPath);
  try {
    const failQueued = database.prepare(`UPDATE documents SET status = 'failed', warnings_json = ?, updated_at = ?
      WHERE dataset_id = ? AND doc_id = ? AND status = 'queued' AND file_type IN ('xlsx', 'xlsm')`);
    for (const file of job.files) {
      if (file.docId) failQueued.run(JSON.stringify([message]), new Date().toISOString(), paths.datasetId, file.docId);
    }
  } finally {
    database.close();
  }
  failPeIngestJob(paths, job, message);
}

export {
  findActivePeIngestJob,
  readPeIngestJob,
  resolvePeProjectPaths,
};
export type { PeIngestJob } from "./contracts.ts";
export type { PeProjectPaths } from "./paths.ts";
