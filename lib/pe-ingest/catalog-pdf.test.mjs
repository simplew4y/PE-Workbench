import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { sourceId } from "@earendil-works/pe-boot/source";
import { textPdf } from "./test-fixtures.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const ingest = await jiti.import("./index.ts");
const jobs = await jiti.import("./jobs.ts");
const { sha256 } = await jiti.import("./paths.ts");
const { findPeDocumentByFilename, findPeDocumentByHash } = await jiti.import("./repository.ts");
const { createPeProject, peProjectStorePaths } = await jiti.import("../pe-project-store.ts");
const { listPeProjectDocuments } = await jiti.import("../pe-project-documents.ts");
const { resolvePeEvidenceSource } = await jiti.import("../pe-source-server.ts");

function fixture(t, texts) {
  assert.ok(fs.existsSync(path.resolve("dist/pe-ingest/worker.mjs")), "Build the worker before these tests");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pe-catalog-pdf-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: "Existing PDF versions" }, options);
  const registryPath = peProjectStorePaths(options).registryPath;
  const paths = ingest.resolvePeProjectPaths(project, registryPath);
  const documents = texts.map((text, index) => ({
    docId: `catalog_pdf_${index + 1}`, version: index + 1, text,
    bytes: textPdf(text), rawPath: `raw/.versions/catalog_pdf_${index + 1}/Report.pdf`,
  }));
  const database = new DatabaseSync(paths.collectionPath);
  try {
    // The catalog migration retains this main document identity and marks PDFs
    // without Node pages failed. Core separately tests the exact legacy DDL upgrade.
    const insert = database.prepare(`INSERT INTO documents (
      doc_id,dataset_id,original_filename,filename_key,raw_path,sha256,status,
      logical_doc_id,version_no,is_current,source_relpath,stored_path,file_type,checksum,
      registration_kind,warnings_json,created_at,updated_at
    ) VALUES (?,?,'Report.pdf','report.pdf',?,?,'failed','main-logical-pdf',?,?,
      'Report.pdf',?,'pdf',?,'catalog','["PDF requires reprocessing with the Node pipeline"]',?,?)`);
    for (const document of documents) {
      fs.mkdirSync(path.dirname(path.join(project.root, document.rawPath)), { recursive: true });
      fs.writeFileSync(path.join(project.root, document.rawPath), document.bytes);
      insert.run(document.docId, project.datasetId, document.rawPath, sha256(document.bytes),
        document.version, document.version === texts.length ? 1 : 0, document.rawPath,
        sha256(document.bytes), `2026-09-0${document.version}`, `2026-09-0${document.version}`);
    }
  } finally { database.close(); }
  return { project, registryPath, options, paths, documents };
}

async function settled(paths, job) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = jobs.readPeIngestJob(paths, job.jobId);
    if (current.status !== "queued" && current.status !== "running") return current;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Job did not finish: ${job.jobId}`);
}

test("reprocesses main PDF history with stable IDs, isolated artifacts, and working historical sources", async (t) => {
  const { project, registryPath, options, paths, documents } = fixture(t, [
    "Historical operating revenue increased during the financial reporting year.",
    "Revised operating revenue decreased during the financial reporting year.",
    "Historical operating revenue increased during the financial reporting year.",
  ]);
  const before = listPeProjectDocuments(project.datasetId, options);
  assert.equal(before.currentCount, 1);
  assert.deepEqual(before.documents.map((document) => document.versionNo).sort(), [1, 2, 3]);
  assert.ok(before.documents.every((document) => document.status === "failed" && document.docId));
  assert.equal(findPeDocumentByFilename(paths.collectionPath, project.datasetId, "Report.pdf"), null);
  assert.equal(findPeDocumentByHash(paths.collectionPath, project.datasetId, sha256(documents[0].bytes)), null);
  for (const document of documents) {
    const result = await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, document.docId));
    assert.equal(result.result.failedCount, 0, JSON.stringify(result));
    assert.equal(result.result.files[0].docId, document.docId);
    const source = await resolvePeEvidenceSource(project.root, sourceId({
      docId: document.docId, location: { kind: "pdf", pageStart: 1, pageEnd: 1 },
    }));
    assert.equal(source.payload.version_no, document.version);
    assert.equal(source.payload.pdf_pages[0].text, document.text);
    assert.equal(source.filePath, path.join(project.root, document.rawPath));
  }
  const database = new DatabaseSync(paths.collectionPath);
  try {
    const rows = database.prepare("SELECT * FROM documents ORDER BY version_no").all();
    assert.deepEqual(rows.map((row) => [row.doc_id, row.version_no, row.is_current, row.logical_doc_id]),
      documents.map((document) => [document.docId, document.version, document.version === 3 ? 1 : 0, "main-logical-pdf"]));
    assert.equal(new Set(rows.map((row) => row.artifact_directory)).size, 3);
    for (const row of rows) {
      assert.match(row.artifact_directory, new RegExp(`^meta/pdf-catalog/${row.doc_id}/[a-f0-9]{16}$`, "u"));
      assert.ok(fs.existsSync(path.join(project.root, row.document_markdown_path)));
      assert.equal(row.raw_path, row.stored_path);
      assert.equal(row.sha256, row.checksum);
    }
    assert.equal(database.prepare("SELECT count(*) AS n FROM pdf_pages_fts WHERE pdf_pages_fts MATCH 'revenue'").get().n, 3);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { database.close(); }
  const upload = { filename: "Report.pdf", mimeType: "application/pdf", content: documents[0].bytes };
  const fresh = await settled(paths, ingest.queuePePdfIngest({ project, registryPath, uploads: [upload] }));
  assert.equal(fresh.result.failedCount, 0, JSON.stringify(fresh));
  assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [upload] }), /already exists/u);
  assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [{ ...upload, filename: "Copy.pdf" }] }), /same PDF content/u);
  const after = listPeProjectDocuments(project.datasetId, options);
  assert.equal(after.currentCount, 2);
  assert.equal(after.documents.filter((document) => document.isCurrent === false).length, 2);
});

test("failed catalog PDF retries preserve published artifacts, page IDs, and the immutable original", async (t) => {
  const { project, registryPath, paths, documents: [document] } = fixture(t, [
    "Published operating revenue and net profit increased during the financial year.",
  ]);
  assert.equal((await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, document.docId))).result.failedCount, 0);
  const database = new DatabaseSync(paths.collectionPath);
  const before = database.prepare("SELECT * FROM documents WHERE doc_id=?").get(document.docId);
  const page = database.prepare("SELECT * FROM pdf_pages WHERE doc_id=?").get(document.docId);
  const originalPath = path.join(project.root, document.rawPath);
  fs.writeFileSync(originalPath, "changed original");
  const changed = await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, document.docId));
  assert.equal(changed.status, "failed");
  assert.match(changed.result.files[0].error, /content changed/u);
  fs.writeFileSync(originalPath, document.bytes);
  database.exec(`CREATE TRIGGER reject_pdf_publish BEFORE UPDATE OF artifact_directory ON documents
    BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`);
  const failed = await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, document.docId));
  assert.equal(failed.status, "failed");
  assert.match(failed.result.files[0].error, /publication failure/u);
  assert.deepEqual(database.prepare("SELECT * FROM documents WHERE doc_id=?").get(document.docId), before);
  assert.deepEqual(database.prepare("SELECT * FROM pdf_pages WHERE doc_id=?").get(document.docId), page);
  assert.equal(database.prepare("SELECT count(*) AS n FROM pdf_pages_fts WHERE doc_id=?").get(document.docId).n, 1);
  database.close();
  assert.deepEqual(fs.readFileSync(originalPath), document.bytes);
  assert.deepEqual(fs.readdirSync(path.join(project.root, "meta", "pdf-catalog", document.docId)), [path.basename(before.artifact_directory)]);
});

test("orphaned catalog PDF processing becomes retryable while preserving historical identity", async (t) => {
  const { project, registryPath, options, paths, documents } = fixture(t, [
    "Historical revenue increased during this financial reporting year.",
    "Current revenue decreased during this financial reporting year.",
  ]);
  const database = new DatabaseSync(paths.collectionPath);
  try {
    database.prepare("UPDATE documents SET status='processing',updated_at=? WHERE doc_id=?")
      .run(new Date(Date.now() - 3 * 60_000).toISOString(), documents[0].docId);
  } finally { database.close(); }
  const historical = listPeProjectDocuments(project.datasetId, options).documents.find((document) => document.docId === documents[0].docId);
  assert.equal(historical.status, "failed");
  assert.equal(historical.isCurrent, false);
  assert.match(historical.warnings.join(" "), /重试/u);
  const result = await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, historical.docId));
  assert.equal(result.result.failedCount, 0, JSON.stringify(result));
  assert.equal(listPeProjectDocuments(project.datasetId, options).documents.find((document) => document.docId === historical.docId).isCurrent, false);
});

test("the PDF parser verifies the bytes it actually parses against the immutable version hash", async (t) => {
  const { project, documents: [document] } = fixture(t, ["The original financial reporting content."]);
  const { processPePdf } = await import(path.resolve("dist/pe-ingest/pdf/parser.js"));
  const originalPath = path.join(project.root, document.rawPath);
  fs.writeFileSync(originalPath, textPdf("Different financial reporting content substituted after the worker check."));
  const staging = path.join(project.root, "meta", "unexpected-stage");
  await assert.rejects(processPePdf({
    datasetId: project.datasetId, originalFilename: "Report.pdf", rawPath: document.rawPath,
    rawAbsolutePath: originalPath, sha256: sha256(document.bytes), stagingDocumentDirectory: staging,
    registeredDocument: { docId: document.docId, generation: "0123456789abcdef" },
  }), /content changed/u);
  assert.equal(fs.existsSync(staging), false);
});

test("managed page previews and file streams reject changed or deleted historical originals", async (t) => {
  const { project, registryPath, paths, documents: [document] } = fixture(t, [
    "Original operating revenue and net profit increased during the financial year.",
  ]);
  const { GET: preview } = await jiti.import("../../app/api/pe/source/route.ts");
  const { GET: original } = await jiti.import("../../app/api/pe/source/file/route.ts");
  const previousRoots = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([project.root]), expiresAt: Date.now() + 60_000 };
  t.after(() => { globalThis.__piAllowedRootsCache = previousRoots; });
  assert.equal((await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, document.docId))).result.failedCount, 0);
  const database = new DatabaseSync(paths.collectionPath);
  t.after(() => database.close());
  const pageId = database.prepare("SELECT page_id FROM pdf_pages WHERE doc_id=?").get(document.docId).page_id;
  const query = new URLSearchParams({ cwd: project.root, evidence_id: `page:${pageId}` });
  const previewRequest = () => new Request(`http://localhost:30141/api/pe/source?${query}`);
  const fileRequest = () => new Request(`http://localhost:30141/api/pe/source/file?${query}`, { headers: { range: "bytes=0-4" } });
  const valid = await preview(previewRequest());
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).pdf_pages[0].text, document.text);
  const bytes = await original(fileRequest());
  assert.equal(bytes.status, 206);
  assert.equal(await bytes.text(), "%PDF-");
  fs.writeFileSync(path.join(project.root, document.rawPath), textPdf("A substituted PDF original."));
  assert.equal((await preview(previewRequest())).status, 409);
  assert.equal((await original(fileRequest())).status, 409);
  fs.writeFileSync(path.join(project.root, document.rawPath), document.bytes);
  database.prepare("UPDATE documents SET deleted_at=? WHERE doc_id=?").run(new Date().toISOString(), document.docId);
  assert.equal((await preview(previewRequest())).status, 404);
  assert.equal((await original(fileRequest())).status, 404);
});
