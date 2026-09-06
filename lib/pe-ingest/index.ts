import type { PeProjectSummary } from "../pe-project-types.ts";
import type { PeIngestJob } from "./contracts.ts";
import {
  createPeIngestJob,
  findActivePeIngestJob,
  newPeIngestJob,
  readPeIngestJob,
  startPeIngestJob,
  updatePeIngestJob,
} from "./jobs.ts";
import {
  hasPeRawFilename,
  normalizePePdfFilename,
  pePdfFilenameKey,
  resolvePeProjectPaths,
  sha256,
  writePeRawFile,
} from "./paths.ts";
import { findPeDocumentByFilename, findPeDocumentByHash } from "./repository.ts";
import { assertPeCollectionDataset } from "./schema.ts";

export const PE_SUPPORTED_EXTENSIONS = new Set([".pdf"]);
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
  const active = findActivePeIngestJob(paths);
  if (active) throw new Error(`项目“${options.project.name}”已有 PDF 处理任务正在运行`);
  const job = newPeIngestJob(paths.datasetId);
  const normalizedUploads = options.uploads.map((upload) => ({
    ...upload,
    filename: normalizePePdfFilename(upload.filename),
  }));
  const queuedNames = new Set<string>();
  const queuedDigests = new Map<string, string>();

  for (const upload of normalizedUploads) {
    const validationError = validatePePdfUpload(upload);
    if (validationError) throw new Error(validationError);
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

  for (const upload of normalizedUploads) {
    const raw = writePeRawFile(paths, upload.filename, upload.content);
    job.files.push({
      originalFilename: upload.filename,
      rawPath: raw.rawPath,
      sha256: raw.sha256,
    });
  }

  createPeIngestJob(paths, job);
  try {
    startPeIngestJob(paths, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.message = message;
    job.finishedAt = new Date().toISOString();
    job.result.failedCount += job.files.length;
    job.result.files.push(...job.files.map((file) => ({
      originalFilename: file.originalFilename,
      status: "failed" as const,
      error: message,
    })));
    updatePeIngestJob(paths, job);
    throw error;
  }
  return job;
}

export {
  findActivePeIngestJob,
  readPeIngestJob,
  resolvePeProjectPaths,
};
export type { PeIngestJob } from "./contracts.ts";
export type { PeProjectPaths } from "./paths.ts";
