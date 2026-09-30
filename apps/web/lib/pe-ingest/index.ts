import path from "node:path";
import { registerPeDocuments, validatePeExcelUpload } from "@earendil-works/pe-boot";
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
  normalizePeDocumentFilename,
  peDocumentFilenameKey,
  resolvePeProjectPaths,
  sha256,
  writePeRawFile,
} from "./paths.ts";
import { findPeDocumentByFilename, findPeDocumentByHash, registeredPePdfInput } from "./repository.ts";
import { assertPeCollectionDataset, openPeCollectionDatabase } from "./schema.ts";

export const PE_SUPPORTED_EXTENSIONS = new Set([".pdf", ".xlsx", ".xlsm"]);
export const PE_PDF_MIME_TYPE = "application/pdf";
const PE_EXCEL_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);

export interface PeResearchUpload {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export type PePdfUpload = PeResearchUpload;

export interface QueuePeIngestOptions {
	parseOnly?: boolean;
  project: PeProjectSummary;
  registryPath: string;
  uploads: PeResearchUpload[];
}

export type QueuePePdfIngestOptions = QueuePeIngestOptions;

export function validatePePdfUpload(upload: PeResearchUpload): string | null {
  try {
    if (path.extname(normalizePeDocumentFilename(upload.filename)).toLocaleLowerCase() !== ".pdf") {
      return `Unsupported PDF file: ${upload.filename}`;
    }
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

export function validatePeResearchUpload(upload: PeResearchUpload): string | null {
  let filename: string;
  try {
    filename = normalizePeDocumentFilename(upload.filename);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const extension = path.extname(filename).toLocaleLowerCase();
  if (!PE_SUPPORTED_EXTENSIONS.has(extension)) return `Unsupported document file: ${filename}`;
  if (extension === ".pdf") return validatePePdfUpload(upload);
  if (!PE_EXCEL_MIME_TYPES.has(upload.mimeType.toLocaleLowerCase())) {
    return `Invalid Excel MIME type for ${filename}`;
  }
  if (upload.content.length < 4 || upload.content.readUInt32LE(0) !== 0x04034b50) {
    return `Invalid Excel OOXML package: ${filename}`;
  }
  try {
    validatePeExcelUpload(upload.content, extension.slice(1));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function acquireSubmissionLock(paths: ReturnType<typeof resolvePeProjectPaths>): () => void {
  try {
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
  const database = openPeCollectionDatabase(paths.collectionPath);
  try {
    const failQueued = database.prepare(`UPDATE documents SET status='failed',warnings_json=?,updated_at=?
      WHERE dataset_id=? AND doc_id=? AND status='queued' AND file_type IN ('xlsx','xlsm')`);
    for (const file of job.files) {
      if (file.docId) {
        failQueued.run(JSON.stringify([message]), new Date().toISOString(), paths.datasetId, file.docId);
      }
    }
  } finally {
    database.close();
  }
  failPeIngestJob(paths, job, message);
}

function launchJob(paths: ReturnType<typeof resolvePeProjectPaths>, job: PeIngestJob): PeIngestJob {
  try {
    createPeIngestJob(paths, job);
    startPeIngestJob(paths, job);
    return job;
  } catch (error) {
    failSavedUploads(paths, job, error);
    throw error;
  }
}

export function queuePeIngest(options: QueuePeIngestOptions): PeIngestJob {
  const paths = resolvePeProjectPaths(options.project, options.registryPath);
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const release = acquireSubmissionLock(paths);
  const job = newPeIngestJob(paths.datasetId);
  job.parseOnly = options.parseOnly === true;
  try {
    if (findActivePeIngestJob(paths)) throw new Error(`项目“${options.project.name}”已有文档处理任务正在运行`);
    const uploads = options.uploads.map((upload) => ({
      ...upload,
      filename: normalizePeDocumentFilename(upload.filename),
    }));
    const names = new Set<string>();
    const digests = new Map<string, string>();
    for (const upload of uploads) {
      const validationError = validatePeResearchUpload(upload);
      if (validationError) throw new Error(validationError);
      const filenameKey = peDocumentFilenameKey(upload.filename);
      if (names.has(filenameKey)) throw new Error(`Duplicate document filename in upload: ${upload.filename}`);
      names.add(filenameKey);
      // Excel registration owns immutable versions and same-content reuse.
      // PDF pipeline uploads retain their existing duplicate checks.
      if (path.extname(upload.filename).toLocaleLowerCase() !== ".pdf") continue;
      const digest = sha256(upload.content);
      const duplicateUpload = digests.get(digest);
      if (duplicateUpload) {
        throw new Error(`The same document content was selected twice: ${duplicateUpload}, ${upload.filename}`);
      }
      digests.set(digest, upload.filename);
      const existingByName = findPeDocumentByFilename(paths.collectionPath, paths.datasetId, upload.filename);
      if (existingByName || hasPeRawFilename(paths, upload.filename)) {
        throw new Error(`Document filename already exists in this project: ${upload.filename}`);
      }
      const existingByHash = findPeDocumentByHash(paths.collectionPath, paths.datasetId, digest);
      if (existingByHash) {
        throw new Error(`The same document content already exists as ${existingByHash.originalFilename}`);
      }
    }

    const excelUploads = uploads.filter((upload) => path.extname(upload.filename).toLocaleLowerCase() !== ".pdf");
    if (excelUploads.length > 0) {
      const registered = registerPeDocuments(
        paths.projectPath,
        paths.datasetId,
        excelUploads.map((upload) => ({ name: upload.filename, bytes: upload.content })),
      );
      for (const document of registered.documents) {
        job.files.push({
          originalFilename: String(document.original_filename),
          rawPath: String(document.raw_path),
          sha256: String(document.sha256),
          docId: String(document.doc_id),
          fileType: String(document.file_type) as "xlsx" | "xlsm",
        });
      }
    }
    for (const upload of uploads.filter((entry) => path.extname(entry.filename).toLocaleLowerCase() === ".pdf")) {
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

export const queuePePdfIngest = queuePeIngest;

export function queuePeDocumentRetry(project: PeProjectSummary, registryPath: string, docId: string): PeIngestJob {
  const paths = resolvePeProjectPaths(project, registryPath);
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const release = acquireSubmissionLock(paths);
  try {
    if (findActivePeIngestJob(paths)) throw new Error("项目已有文档处理任务正在运行");
    const database = openPeCollectionDatabase(paths.collectionPath);
    try {
      const document = database
        .prepare(`SELECT doc_id,original_filename,raw_path,sha256,file_type FROM documents
          WHERE doc_id=? AND dataset_id=?
            AND (file_type IN ('xlsx','xlsm') OR (file_type='pdf' AND registration_kind='catalog'))
            AND deleted_at IS NULL AND lifecycle_state='active'`)
        .get(docId, paths.datasetId) as Record<string, unknown> | undefined;
      if (!document) throw new Error("Retryable document not found");
      const job = newPeIngestJob(paths.datasetId);
      job.files.push(document.file_type === "pdf" ? registeredPePdfInput(paths, docId) : {
        originalFilename: String(document.original_filename),
        rawPath: String(document.raw_path),
        sha256: String(document.sha256),
        docId: String(document.doc_id),
        fileType: String(document.file_type) as "xlsx" | "xlsm",
      });
      return launchJob(paths, job);
    } finally {
      database.close();
    }
  } finally {
    release();
  }
}

export function queuePeExcelRetry(project: PeProjectSummary, registryPath: string, filename: string): PeIngestJob {
  const paths = resolvePeProjectPaths(project, registryPath);
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const database = openPeCollectionDatabase(paths.collectionPath);
  let docId: string;
  try {
    const document = database.prepare(`SELECT doc_id FROM documents
      WHERE dataset_id=? AND file_type IN ('xlsx','xlsm')
        AND is_current=1 AND deleted_at IS NULL AND lifecycle_state='active'
        AND (source_relpath=? OR original_filename=? OR (logical_doc_id GLOB 'doc_*' AND filename_key=?))
      ORDER BY CASE WHEN source_relpath=? OR original_filename=? THEN 0 ELSE 1 END
      LIMIT 1`)
      .get(paths.datasetId, filename, filename, peDocumentFilenameKey(filename), filename, filename);
    if (!document) throw new Error("Excel document not found");
    docId = String(document.doc_id);
  } finally {
    database.close();
  }
  return queuePeDocumentRetry(project, registryPath, docId);
}

export { findActivePeIngestJob, readPeIngestJob, resolvePeProjectPaths };
export type { PeIngestJob } from "./contracts.ts";
export type { PeProjectPaths } from "./paths.ts";
