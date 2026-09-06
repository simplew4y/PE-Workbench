import { statSync } from "node:fs";
import type { PeIngestFileResult, PeIngestInputFile, PeIngestJobResult, PeIngestStatus } from "./pe-ingest/contracts";
import { resolvePeProjectPaths, resolveProjectFile } from "./pe-ingest/paths";
import { openPeCollectionDatabase } from "./pe-ingest/schema";
import { getPeProject, peProjectStorePaths } from "./pe-project-store";
import type {
  PeProjectDocumentCatalog,
  PeProjectDocumentStatus,
  PeProjectDocumentSummary,
} from "./pe-project-types";

interface PeProjectDocumentOptions {
  agentDir?: string;
  projectsRoot?: string;
}

interface DocumentRow {
  original_filename: string;
  raw_path: string;
  status: string;
  page_count: number;
  document_markdown_path: string;
  warnings_json: string;
  created_at: string;
  updated_at: string;
  needs_ocr_page_count: number;
}

interface IngestJobRow {
  status: string;
  message: string;
  input_files_json: string;
  result_json: string;
  warnings_json: string;
  created_at: string;
  updated_at: string;
}

function stringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function ingestInputs(raw: string): PeIngestInputFile[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is PeIngestInputFile => (
      typeof item === "object"
      && item !== null
      && typeof (item as Partial<PeIngestInputFile>).originalFilename === "string"
      && typeof (item as Partial<PeIngestInputFile>).rawPath === "string"
      && typeof (item as Partial<PeIngestInputFile>).sha256 === "string"
    ));
  } catch {
    return [];
  }
}

function ingestResults(raw: string): PeIngestJobResult {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return { files: [], createdCount: 0, failedCount: 0 };
    const candidate = value as Partial<PeIngestJobResult>;
    const files = Array.isArray(candidate.files)
      ? candidate.files.filter((item): item is PeIngestFileResult => (
        typeof item === "object"
        && item !== null
        && typeof (item as Partial<PeIngestFileResult>).originalFilename === "string"
        && ((item as Partial<PeIngestFileResult>).status === "created"
          || (item as Partial<PeIngestFileResult>).status === "failed")
      ))
      : [];
    return {
      files,
      createdCount: typeof candidate.createdCount === "number" ? candidate.createdCount : 0,
      failedCount: typeof candidate.failedCount === "number" ? candidate.failedCount : 0,
    };
  } catch {
    return { files: [], createdCount: 0, failedCount: 0 };
  }
}

function documentStatus(value: string): PeProjectDocumentStatus {
  if (
    value === "queued"
    || value === "running"
    || value === "completed"
    || value === "completed_with_warnings"
    || value === "failed"
  ) {
    return value;
  }
  return "failed";
}

function jobStatus(value: string): PeIngestStatus | null {
  if (
    value === "queued"
    || value === "running"
    || value === "completed"
    || value === "completed_with_warnings"
    || value === "failed"
  ) {
    return value;
  }
  return null;
}

function safeProjectFile(
  paths: ReturnType<typeof resolvePeProjectPaths>,
  relativePath: string,
): { relativePath: string; sizeBytes: number } | null {
  try {
    const absolutePath = resolveProjectFile(paths, relativePath);
    return { relativePath, sizeBytes: statSync(absolutePath).size };
  } catch {
    return null;
  }
}

function publicMessage(value: string): string {
  return value.replace(
    /(^|[\s("'`=:])((?:[A-Za-z]:[\\/]|\/{1,2}|\\\\)[^\s"'`<>]*)/gu,
    "$1[local path]",
  );
}

export function listPeProjectDocuments(
  datasetId: string,
  options: PeProjectDocumentOptions = {},
): PeProjectDocumentCatalog {
  const project = getPeProject(datasetId, options);
  const paths = resolvePeProjectPaths(project, peProjectStorePaths(options).registryPath);
  const database = openPeCollectionDatabase(paths.collectionPath);
  try {
    const documentRows = database.prepare(`
      SELECT
        d.original_filename,
        d.raw_path,
        d.status,
        d.page_count,
        d.document_markdown_path,
        d.warnings_json,
        d.created_at,
        d.updated_at,
        SUM(CASE WHEN p.text_quality = 'needs_ocr' THEN 1 ELSE 0 END) AS needs_ocr_page_count
      FROM documents d
      LEFT JOIN pdf_pages p ON p.doc_id = d.doc_id
      WHERE d.dataset_id = ?
      GROUP BY d.doc_id
      ORDER BY d.created_at DESC
    `).all(datasetId) as unknown as DocumentRow[];

    const documents: PeProjectDocumentSummary[] = [];
    const knownFilenames = new Set<string>();
    for (const row of documentRows) {
      const rawFile = safeProjectFile(paths, row.raw_path);
      const markdownFile = safeProjectFile(paths, row.document_markdown_path);
      const warnings = stringArray(row.warnings_json).map(publicMessage);
      const needsOcrPageCount = Number(row.needs_ocr_page_count) || 0;
      documents.push({
        filename: row.original_filename,
        status: documentStatus(row.status),
        pageCount: Number(row.page_count) || 0,
        sizeBytes: rawFile?.sizeBytes ?? null,
        uploadedAt: row.created_at,
        updatedAt: row.updated_at,
        warningCount: warnings.length,
        warnings,
        needsOcrPageCount,
        rawRelativePath: rawFile?.relativePath ?? null,
        markdownRelativePath: markdownFile?.relativePath ?? null,
      });
      knownFilenames.add(row.original_filename.normalize("NFKC").toLocaleLowerCase("und"));
    }

    const jobRows = database.prepare(`
      SELECT status, message, input_files_json, result_json, warnings_json, created_at, updated_at
      FROM ingest_jobs
      WHERE dataset_id = ?
      ORDER BY updated_at DESC
    `).all(datasetId) as unknown as IngestJobRow[];
    for (const row of jobRows) {
      const status = jobStatus(row.status);
      if (!status) continue;
      const results = ingestResults(row.result_json);
      const resultsByFilename = new Map(results.files.map((file) => [file.originalFilename, file]));
      for (const input of ingestInputs(row.input_files_json)) {
        const filenameKey = input.originalFilename.normalize("NFKC").toLocaleLowerCase("und");
        if (knownFilenames.has(filenameKey)) continue;
        const result = resultsByFilename.get(input.originalFilename);
        if (status !== "queued" && status !== "running" && result?.status !== "failed") continue;
        const rawFile = safeProjectFile(paths, input.rawPath);
        const warnings = [
          ...(result?.warnings ?? []),
          ...stringArray(row.warnings_json),
          ...(result?.error ? [result.error] : []),
        ].map(publicMessage).filter((warning, index, all) => warning && all.indexOf(warning) === index);
        if (status === "failed" && warnings.length === 0 && row.message) warnings.push(publicMessage(row.message));
        documents.push({
          filename: input.originalFilename,
          status: status === "queued" || status === "running" ? status : "failed",
          pageCount: 0,
          sizeBytes: rawFile?.sizeBytes ?? null,
          uploadedAt: row.created_at,
          updatedAt: row.updated_at,
          warningCount: warnings.length,
          warnings,
          needsOcrPageCount: 0,
          rawRelativePath: rawFile?.relativePath ?? null,
          markdownRelativePath: null,
        });
        knownFilenames.add(filenameKey);
      }
    }

    documents.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
    return { documents };
  } finally {
    database.close();
  }
}
