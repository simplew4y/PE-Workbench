import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PeIngestJob,
  PeParsedPdfDocument,
} from "./contracts.ts";
import {
  isPathInside,
  pePdfDocumentName,
  pePdfFilenameKey,
  type PeProjectPaths,
} from "./paths.ts";
import { assertPeCollectionDataset, openPeCollectionDatabase } from "./schema.ts";

interface ExistingDocumentRow {
  doc_id: string;
  original_filename: string;
  raw_path: string;
}

interface CountRow {
  count: number;
}

export interface ExistingPeDocument {
  docId: string;
  originalFilename: string;
  rawPath: string;
}

export function findPeDocumentByHash(
  collectionPath: string,
  datasetId: string,
  digest: string,
): ExistingPeDocument | null {
  assertPeCollectionDataset(collectionPath, datasetId);
  const database = openPeCollectionDatabase(collectionPath);
  try {
    const row = database.prepare(`
      SELECT doc_id, original_filename, raw_path
      FROM documents
      WHERE dataset_id = ? AND file_type = 'pdf' AND sha256 = ?
      LIMIT 1
    `).get(datasetId, digest) as unknown as ExistingDocumentRow | undefined;
    return row ? {
      docId: row.doc_id,
      originalFilename: row.original_filename,
      rawPath: row.raw_path,
    } : null;
  } finally {
    database.close();
  }
}

export function findPeDocumentByFilename(
  collectionPath: string,
  datasetId: string,
  filename: string,
): ExistingPeDocument | null {
  assertPeCollectionDataset(collectionPath, datasetId);
  const database = openPeCollectionDatabase(collectionPath);
  try {
    const row = database.prepare(`
      SELECT doc_id, original_filename, raw_path
      FROM documents
      WHERE dataset_id = ? AND file_type = 'pdf' AND filename_key = ?
      LIMIT 1
    `).get(datasetId, pePdfFilenameKey(filename)) as unknown as ExistingDocumentRow | undefined;
    return row ? {
      docId: row.doc_id,
      originalFilename: row.original_filename,
      rawPath: row.raw_path,
    } : null;
  } finally {
    database.close();
  }
}

function writeJobRow(database: DatabaseSync, job: PeIngestJob): void {
  const updatedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO ingest_jobs (
      job_id, dataset_id, status, message, input_files_json, result_json,
      warnings_json, created_at, started_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      message = excluded.message,
      input_files_json = excluded.input_files_json,
      result_json = excluded.result_json,
      warnings_json = excluded.warnings_json,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `).run(
    job.jobId,
    job.datasetId,
    job.status,
    job.message,
    JSON.stringify(job.files),
    JSON.stringify(job.result),
    JSON.stringify(job.warnings),
    job.createdAt,
    job.startedAt ?? null,
    job.finishedAt ?? null,
    updatedAt,
  );
}

export function savePeIngestJobToDatabase(paths: PeProjectPaths, job: PeIngestJob): void {
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const database = openPeCollectionDatabase(paths.collectionPath);
  try {
    writeJobRow(database, job);
  } finally {
    database.close();
  }
}

export function saveParsedPeDocument(
  paths: PeProjectPaths,
  document: PeParsedPdfDocument,
): void {
  if (document.datasetId !== paths.datasetId) {
    throw new Error("Parsed document does not belong to the selected dataset");
  }
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const database = openPeCollectionDatabase(paths.collectionPath);
  const now = new Date().toISOString();
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database.prepare(
        "SELECT doc_id FROM documents WHERE dataset_id = ? AND file_type = 'pdf' AND (sha256 = ? OR filename_key = ?)",
      ).get(
        paths.datasetId,
        document.sha256,
        pePdfFilenameKey(document.originalFilename),
      ) as { doc_id: string } | undefined;
      if (existing) throw new Error(`Document name or content already indexed as ${existing.doc_id}`);

      database.prepare(`
        INSERT INTO documents (
          doc_id, dataset_id, original_filename, filename_key, raw_path, sha256,
          status, page_count, parser_name, parser_version,
          title, brokerage, document_date, rating, target_price, exhibits_json,
          pdf_metadata_json, artifact_directory, document_markdown_path,
          layout_json_path, warnings_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        document.docId,
        document.datasetId,
        document.originalFilename,
        pePdfFilenameKey(document.originalFilename),
        document.rawPath,
        document.sha256,
        document.warnings.length > 0 ? "completed_with_warnings" : "completed",
        document.pages.length,
        document.parserName,
        document.parserVersion,
        document.metadata.title,
        document.metadata.brokerage,
        document.metadata.documentDate,
        document.metadata.rating,
        document.metadata.targetPrice,
        JSON.stringify(document.metadata.exhibits),
        JSON.stringify(document.metadata.pdfMetadata),
        document.artifactDirectory,
        document.documentMarkdownPath,
        document.layoutJsonPath,
        JSON.stringify(document.warnings),
        now,
        now,
      );

      const insertPage = database.prepare(`
        INSERT INTO pdf_pages (
          page_id, doc_id, page_number, page_text, page_header, role,
          role_signals_json, text_quality, quality_signals_json, width, height,
          rotation, image_paths_json, embedded_image_count,
          large_embedded_image_count, drawing_operator_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertBlock = database.prepare(`
        INSERT INTO pdf_page_blocks (
          block_id, page_id, block_index, block_type, block_text, x, y, width,
          height, reading_order, column_no, font_names_json, directions_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertSearch = database.prepare(
        "INSERT INTO pdf_pages_fts (page_id, doc_id, page_text) VALUES (?, ?, ?)",
      );

      for (const page of document.pages) {
        insertPage.run(
          page.pageId,
          document.docId,
          page.pageNumber,
          page.text,
          page.pageHeader,
          page.role,
          JSON.stringify(page.roleSignals),
          page.textQuality,
          JSON.stringify(page.qualitySignals),
          page.width,
          page.height,
          page.rotation,
          JSON.stringify(page.imagePaths),
          page.imageStatistics.embeddedImageCount,
          page.imageStatistics.largeEmbeddedImageCount,
          page.imageStatistics.drawingOperatorCount,
        );
        for (const block of page.blocks) {
          insertBlock.run(
            block.blockId,
            page.pageId,
            block.blockIndex,
            block.blockType,
            block.text,
            block.x,
            block.y,
            block.width,
            block.height,
            block.readingOrder,
            block.columnNo,
            JSON.stringify(block.fontNames),
            JSON.stringify(block.directions),
          );
        }
        insertSearch.run(page.pageId, document.docId, `${page.pageHeader}\n${page.text}`);
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may not have started.
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

export function commitParsedPeDocument(
  paths: PeProjectPaths,
  stagingDocumentDirectory: string,
  document: PeParsedPdfDocument,
): void {
  const documentsRoot = realpathSync(paths.documentsPath);
  const textRoot = realpathSync(paths.textPath);
  const stagingDirectory = realpathSync(stagingDocumentDirectory);
  if (!isPathInside(realpathSync(paths.stagingPath), stagingDirectory)) {
    throw new Error("Document staging directory escapes the PE workspace");
  }
  const documentName = pePdfDocumentName(document.originalFilename);
  const finalDirectory = path.join(documentsRoot, documentName);
  const finalMarkdown = path.join(textRoot, `${documentName}.md`);
  const stagingMarkdown = path.join(stagingDirectory, "document.md");
  const expectedArtifactDirectory = `meta/documents/${documentName}`;
  if (
    document.artifactDirectory !== expectedArtifactDirectory
    || document.documentMarkdownPath !== `meta/text/${documentName}.md`
    || document.layoutJsonPath !== `${expectedArtifactDirectory}/layout.json`
  ) {
    throw new Error("Parsed document paths do not match its source filename");
  }
  if (
    !isPathInside(documentsRoot, finalDirectory)
    || !isPathInside(textRoot, finalMarkdown)
    || existsSync(finalDirectory)
    || existsSync(finalMarkdown)
  ) {
    throw new Error("Document artifact destination already exists or is unsafe");
  }
  const markdownMetadata = lstatSync(stagingMarkdown);
  if (!markdownMetadata.isFile() || markdownMetadata.isSymbolicLink()) {
    throw new Error("Staged document Markdown is not a regular file");
  }
  try {
    renameSync(stagingMarkdown, finalMarkdown);
    renameSync(stagingDirectory, finalDirectory);
    saveParsedPeDocument(paths, document);
  } catch (error) {
    if (existsSync(finalDirectory)) {
      const resolved = realpathSync(finalDirectory);
      if (isPathInside(documentsRoot, resolved)) rmSync(resolved, { recursive: true, force: true });
    }
    if (existsSync(finalMarkdown)) {
      const resolved = realpathSync(finalMarkdown);
      if (isPathInside(textRoot, resolved)) rmSync(resolved, { force: true });
    }
    throw error;
  }
}

export function updatePeProjectRegistry(paths: PeProjectPaths): void {
  const collection = openPeCollectionDatabase(paths.collectionPath);
  let fileCount = 0;
  try {
    const row = collection.prepare(`
      SELECT COUNT(*) AS count FROM documents
      WHERE dataset_id = ? AND is_current = 1 AND deleted_at IS NULL AND lifecycle_state = 'active'
    `).get(paths.datasetId) as unknown as CountRow;
    fileCount = Number(row.count);
  } finally {
    collection.close();
  }

  const registry = new DatabaseSync(paths.registryPath, { timeout: 10_000 });
  try {
    registry.exec("PRAGMA busy_timeout=10000");
    const row = registry.prepare(
      "SELECT dataset_root FROM datasets WHERE dataset_id = ?",
    ).get(paths.datasetId) as { dataset_root: string } | undefined;
    if (!row || realpathSync(row.dataset_root) !== paths.projectPath) {
      throw new Error("Project registry no longer matches the ingest workspace");
    }
    registry.prepare(`
      UPDATE datasets
      SET file_count = ?, status = ?, updated_at = ?
      WHERE dataset_id = ?
    `).run(fileCount, fileCount > 0 ? "ready" : "draft", new Date().toISOString(), paths.datasetId);
  } finally {
    registry.close();
  }
}
