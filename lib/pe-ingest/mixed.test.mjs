import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { spawnSync } from "node:child_process";
import { lockSync } from "proper-lockfile";
import { registerPeDocuments, preparePeDocument } from "@earendil-works/pe-boot/documents";
import { resolvePeEvidenceSource } from "@earendil-works/pe-boot/evidence";
import { sourceId } from "@earendil-works/pe-boot/source";
import { readPePdfPages, searchPePdfPages } from "@earendil-works/pe-boot";
import { textPdf, workbookBytes } from "./test-fixtures.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const ingest = await jiti.import("./index.ts");
const jobs = await jiti.import("./jobs.ts");
const { createPeProject, peProjectStorePaths } = await jiti.import("../pe-project-store.ts");
const { listPeProjectDocuments } = await jiti.import("../pe-project-documents.ts");

function fixture(t) {
  assert.ok(fs.existsSync(path.resolve("dist/pe-ingest/worker.mjs")), "Build the ingest worker before integration tests");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pe-mixed-ingest-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: "Mixed files" }, options);
  const registryPath = peProjectStorePaths(options).registryPath;
  return { project, registryPath, options, paths: ingest.resolvePeProjectPaths(project, registryPath) };
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

const excelUpload = (value, filename = "Model.xlsx") => ({ filename, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: workbookBytes(value) });

test("uploads and opens PDF and Excel files with full-width punctuation without renaming them", async (t) => {
  const { project, registryPath, options, paths } = fixture(t);
  const pdfName = "Bernstein-Lululemon Athletica Inc（LULU.US）Lululemon： Product issue or brand-0swp (2).pdf";
  const excelName = "模型（LULU.US）：估值.xlsx";
  const content = "Revenue and operating profit appear in this filename regression fixture.";
  const pdf = { filename: pdfName, mimeType: "application/pdf", content: textPdf(content) };
  const job = ingest.queuePeIngest({ project, registryPath, uploads: [pdf, excelUpload(100, excelName)] });
  const result = await settled(paths, job);
  assert.equal(result.result.failedCount, 0, JSON.stringify(result));
  assert.equal(result.result.createdCount, 2);
  const catalog = listPeProjectDocuments(project.datasetId, options);
  assert.deepEqual(catalog.documents.map((document) => document.filename).sort(), [pdfName, excelName].sort());
  assert.deepEqual(fs.readFileSync(path.join(project.root, "raw", pdfName)), pdf.content);
  const pdfId = result.result.files.find((file) => file.originalFilename === pdfName).docId;
  const source = await resolvePeEvidenceSource(project.root, sourceId({ docId: pdfId, location: { kind: "pdf", pageStart: 1, pageEnd: 1 } }));
  assert.equal(source.payload.content, content);
  assert.equal(path.basename(source.filePath), pdfName);
  const workbook = await preparePeDocument(project.root, { path: excelName, datasetId: project.datasetId });
  assert.equal(workbook.document.original_filename, excelName);
  assert.throws(() => ingest.queuePeIngest({ project, registryPath, uploads: [pdf] }), /already exists/u);
});

test("rejects equivalent Unicode filenames before saving a batch", (t) => {
  const { project, registryPath, paths } = fixture(t);
  const upload = (filename, value) => ({ filename, mimeType: "application/pdf", content: textPdf(`Revenue ${value}`) });
  assert.throws(() => ingest.queuePeIngest({ project, registryPath, uploads: [upload("Report（1）.pdf", 100), upload("Report(1).pdf", 200)] }), /Duplicate document filename/u);
  assert.deepEqual(fs.readdirSync(paths.rawPath), []);
});

test("legacy filename retries select the exact case-sensitive workbook identity", async (t) => {
  const { project, registryPath, options, paths } = fixture(t);
  const inputs = [{ name: "Model.xlsx", bytes: workbookBytes(100) }, { name: "model.xlsx", bytes: workbookBytes(200) }];
  const { documents } = registerPeDocuments(project.root, project.datasetId, inputs);
  assert.notEqual(documents[0].doc_id, documents[1].doc_id);
  assert.notEqual(documents[0].logical_doc_id, documents[1].logical_doc_id);
  assert.notEqual(documents[0].raw_path, documents[1].raw_path);
  for (const index of [1, 0]) {
    const retry = ingest.queuePeExcelRetry(project, registryPath, inputs[index].name);
    assert.equal(retry.files[0].docId, documents[index].doc_id);
    const result = await settled(paths, retry);
    assert.equal(result.result.failedCount, 0, JSON.stringify(result));
    assert.equal(result.result.createdCount, 1);
    assert.deepEqual(fs.readFileSync(path.join(project.root, documents[index].raw_path)), inputs[index].bytes);
  }
  assert.throws(() => ingest.queuePeExcelRetry(project, registryPath, "MODEL.xlsx"), /not found/u);
  const catalog = listPeProjectDocuments(project.datasetId, options);
  assert.equal(catalog.currentCount, 2);
  assert.ok(catalog.documents.every((document) => document.isCurrent && document.versionNo === 1 && document.status.startsWith("completed")));
  const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
  try {
    for (const [index, document] of documents.entries()) {
      assert.equal(database.prepare("SELECT numeric_value FROM excel_cells WHERE doc_id=? AND sheet_name='Model' AND cell_ref='B1'").get(document.doc_id).numeric_value, (index + 1) * 100);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM documents").get().n, 2);
  } finally { database.close(); }
});

test("historical catalog PDF retries preserve originals, citations, current search, and published metadata", async (t) => {
  const { project, registryPath, options, paths } = fixture(t);
  const historicalText = "Historical revenue was 100 million and operating profit increased during the previous reporting year.";
  const currentText = "Current revenue was 250 million and operating profit grew strongly during the current year.";
  const originals = [textPdf(historicalText), textPdf(currentText)];
  const versions = [];
  let oldPageId;
  let firstArtifactDirectory;
  for (const bytes of originals) {
    const document = registerPeDocuments(project.root, project.datasetId, [{ name: "Versioned.pdf", bytes }]).documents[0];
    versions.push(document);
    const retry = ingest.queuePeDocumentRetry(project, registryPath, document.doc_id);
    assert.equal(retry.files[0].registrationKind, "catalog");
    const result = await settled(paths, retry);
    assert.equal(result.result.failedCount, 0, JSON.stringify(result));
    assert.equal(result.result.createdCount, 1);
    if (versions.length === 1) {
      const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
      try {
        oldPageId = database.prepare("SELECT page_id FROM pdf_pages WHERE doc_id=? AND page_number=1").get(document.doc_id).page_id;
        firstArtifactDirectory = database.prepare("SELECT artifact_directory FROM documents WHERE doc_id=?").get(document.doc_id).artifact_directory;
      } finally { database.close(); }
    }
  }
  assert.equal(versions[1].logical_doc_id, versions[0].logical_doc_id);
  assert.equal(versions[1].supersedes_doc_id, versions[0].doc_id);
  const historicalRetry = ingest.queuePeDocumentRetry(project, registryPath, versions[0].doc_id);
  const retried = await settled(paths, historicalRetry);
  assert.equal(retried.result.failedCount, 0, JSON.stringify(retried));
  assert.equal(retried.result.files[0].docId, versions[0].doc_id);

  for (const id of [sourceId({ docId: versions[0].doc_id, location: { kind: "pdf", pageStart: 1, pageEnd: 1 } }), `page:${oldPageId}`]) {
    const evidence = await resolvePeEvidenceSource(project.root, id);
    assert.equal(evidence.payload.doc_id, versions[0].doc_id);
    assert.equal(evidence.payload.version_no, 1);
    assert.equal(evidence.payload.content, historicalText);
    assert.equal(evidence.filePath, path.join(project.root, versions[0].raw_path));
  }
  const search = searchPePdfPages(project.root, { queries: ["revenue"], datasetId: project.datasetId });
  assert.equal(search.result_count, 1);
  assert.equal(search.results[0].doc_id, versions[1].doc_id);
  assert.equal(search.results[0].version_no, 2);
  assert.match(search.results[0].excerpt, /Current revenue was 250/u);
  const historicalRead = readPePdfPages(project.root, { docId: versions[0].doc_id, pageStart: 1 });
  assert.equal(historicalRead.document.doc_id, versions[0].doc_id);
  assert.equal(historicalRead.document.version_no, 1);
  assert.equal(historicalRead.pages[0].content, historicalText);

  const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
  try {
    for (const [index, document] of versions.entries()) {
      const row = database.prepare("SELECT * FROM documents WHERE doc_id=?").get(document.doc_id);
      assert.equal(row.version_no, index + 1);
      assert.equal(row.is_current, index === 1 ? 1 : 0);
      assert.equal(row.file_size, originals[index].length);
      assert.equal(row.sha256, document.sha256);
      assert.equal(row.checksum, document.checksum);
      assert.equal(row.readable_text_path, row.document_markdown_path);
      assert.match(row.readable_text_path, new RegExp(`^meta/pdf-catalog/${document.doc_id}/[a-f0-9]{16}/document\\.md$`, "u"));
      const readable = fs.readFileSync(path.join(project.root, row.readable_text_path), "utf8");
      assert.ok(readable.includes(index === 0 ? historicalText : currentText), JSON.stringify({ index, readable }));
      assert.deepEqual(fs.readFileSync(path.join(project.root, row.raw_path)), originals[index]);
      if (index === 0) assert.notEqual(row.artifact_directory, firstArtifactDirectory);
    }
    assert.equal(database.prepare("SELECT page_id FROM pdf_pages WHERE doc_id=? AND page_number=1").get(versions[0].doc_id).page_id, oldPageId);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { database.close(); }
  const catalog = listPeProjectDocuments(project.datasetId, options);
  assert.equal(catalog.documents.length, 2);
  assert.equal(catalog.currentCount, 1);
  assert.equal(catalog.documents.filter((document) => document.isCurrent)[0].docId, versions[1].doc_id);
});

test("mixed uploads preserve PDF search, Excel version history, and share preparation with agents", async (t) => {
  const { project, registryPath, options, paths } = fixture(t);
  const pdf = { filename: "Research.pdf", mimeType: "application/pdf", content: textPdf("Operating revenue and net profit increased during the reporting year.") };
  const first = ingest.queuePePdfIngest({ project, registryPath, uploads: [pdf, excelUpload(100)] });
  const excel = first.files.find((file) => file.fileType === "xlsx");
  assert.ok(excel.docId);
  // An agent arriving during the background upload uses the same per-document preparation service.
  const opened = preparePeDocument(project.root, { docId: excel.docId, datasetId: project.datasetId });
  const outcomes = await Promise.allSettled([settled(paths, first), opened]);
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  const [firstResult, prepared] = outcomes.map((outcome) => outcome.value);
  assert.equal(firstResult.result.failedCount, 0, JSON.stringify(firstResult));
  assert.equal(firstResult.result.createdCount, 2);
  assert.ok(prepared.readablePath);
  assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [pdf] }), /already exists/u);
  assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [{ ...pdf, filename: "Other.pdf" }] }), /same document content/u);

  for (const value of [200, 100]) {
    const job = ingest.queuePePdfIngest({ project, registryPath, uploads: [excelUpload(value)] });
    const result = await settled(paths, job);
    assert.equal(result.result.failedCount, 0, JSON.stringify(result));
  }
  const catalog = listPeProjectDocuments(project.datasetId, options);
  const versions = catalog.documents.filter((document) => document.filename === "Model.xlsx");
  assert.deepEqual(versions.map((document) => document.versionNo).sort(), [1, 2, 3]);
  assert.equal(versions.filter((document) => document.isCurrent).length, 1);
  assert.equal(versions.find((document) => document.isCurrent).versionNo, 3);
  assert.equal(catalog.currentCount, 2);
  assert.equal(new Set(versions.map((document) => document.docId)).size, 3);
  const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM pdf_pages_fts WHERE pdf_pages_fts MATCH 'revenue'").get().n, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM excel_cells WHERE doc_id = ?").get(excel.docId).n, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM excel_defined_names WHERE doc_id = ?").get(excel.docId).n, 1);
  } finally { database.close(); }
  const registry = new DatabaseSync(registryPath, { readOnly: true });
  try { assert.equal(registry.prepare("SELECT file_count FROM datasets WHERE dataset_id = ?").get(project.datasetId).file_count, 2); }
  finally { registry.close(); }
});

test("blocks another server process from registering an upload or retry during submission", (t) => {
  const { project, registryPath, paths } = fixture(t);
  const release = lockSync(paths.collectionPath, { lockfilePath: path.join(paths.metaPath, ".ingest-submit.lock"), stale: 300_000 });
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { createJiti } from 'jiti';
      import assert from 'node:assert/strict';
      const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
      const ingest = await jiti.import('./lib/pe-ingest/index.ts');
      const { project, registryPath } = JSON.parse(process.env.PE_TEST_PROJECT);
      assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [] }), /正在运行/u);
      assert.throws(() => ingest.queuePeDocumentRetry(project, registryPath, 'not-registered'), /正在运行/u);
    `], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PE_TEST_PROJECT: JSON.stringify({ project, registryPath }) } });
    assert.equal(child.status, 0, child.stderr);
    const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
    try { assert.equal(database.prepare("SELECT COUNT(*) AS n FROM documents").get().n, 0); }
    finally { database.close(); }
  } finally { release(); }
});

test("keeps registered Excel retryable when worker launch or a later PDF write fails", async (t) => {
  const { project, registryPath, options, paths } = fixture(t);
  const previousCwd = process.cwd();
  try {
    process.chdir(project.root);
    assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [excelUpload(100, "Launch.xlsx")] }), /worker is missing/u);
  } finally { process.chdir(previousCwd); }
  assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [
    excelUpload(100, "Partial.xlsx"),
    { filename: `${"a".repeat(300)}.pdf`, mimeType: "application/pdf", content: textPdf("PDF cannot be stored under an overlong filename.") },
  ] }), /ENAMETOOLONG|name too long/u);
  const catalog = listPeProjectDocuments(project.datasetId, options);
  assert.equal(catalog.documents.length, 2);
  assert.ok(catalog.documents.every((document) => document.status === "failed" && document.docId));
  const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'failed'").get().n, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM ingest_jobs WHERE status = 'failed'").get().n, 2);
  } finally { database.close(); }
  for (const document of catalog.documents) {
    const retried = await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, document.docId));
    assert.equal(retried.result.failedCount, 0, JSON.stringify(retried));
  }
});

test("rejects ZIP signatures without a real OOXML workbook before creating a document", (t) => {
  const { project, registryPath, paths } = fixture(t);
  assert.throws(() => ingest.queuePePdfIngest({ project, registryPath, uploads: [{ ...excelUpload(100), content: Buffer.from([0x50, 0x4b, 3, 4]) }] }), /ZIP|zip|OOXML|workbook|Workbook|package/u);
  const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
  try { assert.equal(database.prepare("SELECT COUNT(*) AS n FROM documents").get().n, 0); }
  finally { database.close(); }
});

test("retries a failed Excel preparation from its registered original without making another version", async (t) => {
  const { project, registryPath, options, paths } = fixture(t);
  const { documents: [document] } = registerPeDocuments(project.root, project.datasetId, [{ name: "Retry.xlsx", bytes: workbookBytes(100) }]);
  const job = jobs.newPeIngestJob(project.datasetId);
  job.files.push({ originalFilename: "Retry.xlsx", rawPath: document.raw_path, sha256: document.sha256, fileType: "xlsx", docId: document.doc_id });
  jobs.createPeIngestJob(paths, job);
  const previousPython = process.env.PE_DOCUMENT_PYTHON;
  const previousExcelPython = process.env.PE_EXCEL_PYTHON;
  try {
    process.env.PE_DOCUMENT_PYTHON = path.join(project.root, "missing-python");
    process.env.PE_EXCEL_PYTHON = process.env.PE_DOCUMENT_PYTHON;
    jobs.startPeIngestJob(paths, job);
  } finally {
    if (previousPython === undefined) delete process.env.PE_DOCUMENT_PYTHON;
    else process.env.PE_DOCUMENT_PYTHON = previousPython;
    if (previousExcelPython === undefined) delete process.env.PE_EXCEL_PYTHON;
    else process.env.PE_EXCEL_PYTHON = previousExcelPython;
  }
  const failed = await settled(paths, job);
  assert.equal(failed.status, "failed");
  assert.equal(listPeProjectDocuments(project.datasetId, options).documents[0].status, "failed");
  const retry = ingest.queuePeDocumentRetry(project, registryPath, document.doc_id);
  const result = await settled(paths, retry);
  assert.equal(result.result.failedCount, 0, JSON.stringify(result));
  const catalog = listPeProjectDocuments(project.datasetId, options);
  assert.equal(catalog.documents.length, 1);
  assert.equal(catalog.documents[0].docId, document.doc_id);
  assert.notEqual(catalog.documents[0].status, "failed");
});

test("recovers orphaned registrations without interrupting agent leases, live workers, or fresh uploads", async (t) => {
  const { project, registryPath, options, paths } = fixture(t);
  const names = ["OrphanQueued.xlsx", "OrphanProcessing.xlsx", "Fresh.xlsx", "Agent.xlsx", "LiveUi.xlsx", "RecentUi.xlsx"];
  const { documents } = registerPeDocuments(project.root, project.datasetId, names.map((name) => ({ name, bytes: workbookBytes(100) })));
  const byName = new Map(documents.map((document) => [document.original_filename, document]));
  const old = new Date(Date.now() - 3 * 60_000).toISOString();
  const makeJob = (name) => {
    const document = byName.get(name);
    const job = jobs.newPeIngestJob(project.datasetId);
    job.files.push({ originalFilename: name, rawPath: document.raw_path, sha256: document.sha256, fileType: "xlsx", docId: document.doc_id });
    jobs.createPeIngestJob(paths, job);
    return job;
  };
  const live = makeJob("LiveUi.xlsx");
  live.status = "running";
  live.workerPid = process.pid;
  live.startedAt = old;
  live.heartbeatAt = old;
  jobs.updatePeIngestJob(paths, live);
  const stale = makeJob("OrphanProcessing.xlsx");
  const recent = makeJob("RecentUi.xlsx");
  const oldFailure = makeJob("Agent.xlsx");
  jobs.failPeIngestJob(paths, oldFailure, "An earlier attempt failed");
  for (const job of [stale, recent]) fs.rmSync(path.join(paths.jobDirectory, `${job.jobId}.json`));
  const database = new DatabaseSync(paths.collectionPath);
  try {
    database.prepare("UPDATE documents SET updated_at=? WHERE original_filename <> 'Fresh.xlsx'").run(old);
    database.prepare("UPDATE documents SET status='processing' WHERE original_filename IN ('OrphanProcessing.xlsx','Agent.xlsx')").run();
    database.prepare("UPDATE ingest_jobs SET updated_at=? WHERE job_id IN (?, ?, ?)").run(old, live.jobId, stale.jobId, oldFailure.jobId);
    const lease = database.prepare(`INSERT INTO processing_jobs
      (job_key,doc_id,revision,status,owner_id,lease_expires_at,attempt,error,created_at,updated_at)
      VALUES (?,?,'test-revision','processing','test-owner',?,1,'',?,?)`);
    for (const [name, expiry] of [["Agent.xlsx", Date.now() + 60_000], ["OrphanProcessing.xlsx", Date.now() - 60_000]]) {
      const docId = byName.get(name).doc_id;
      lease.run(`${docId}:test-revision`, docId, expiry, old, old);
    }
  } finally { database.close(); }
  const catalog = listPeProjectDocuments(project.datasetId, options);
  const statuses = new Map(catalog.documents.map((document) => [document.filename, document.status]));
  assert.equal(statuses.get("OrphanQueued.xlsx"), "failed");
  assert.equal(statuses.get("OrphanProcessing.xlsx"), "failed", "stale UI job must not override recovery");
  assert.equal(statuses.get("Fresh.xlsx"), "queued");
  assert.equal(statuses.get("Agent.xlsx"), "running", "old failed UI job must not override the active agent");
  assert.equal(statuses.get("LiveUi.xlsx"), "running");
  assert.equal(statuses.get("RecentUi.xlsx"), "queued");
  assert.equal(catalog.currentCount, names.length);
  for (const document of catalog.documents) {
    assert.equal(document.isCurrent, true);
    assert.ok(document.rawRelativePath);
    assert.ok(fs.existsSync(path.join(project.root, document.rawRelativePath)));
  }
  live.status = "completed";
  jobs.updatePeIngestJob(paths, live);
  for (const name of ["OrphanQueued.xlsx", "OrphanProcessing.xlsx"]) {
    const result = await settled(paths, ingest.queuePeDocumentRetry(project, registryPath, byName.get(name).doc_id));
    assert.equal(result.result.failedCount, 0, JSON.stringify(result));
  }
  const finalCatalog = listPeProjectDocuments(project.datasetId, options);
  assert.equal(finalCatalog.documents.length, names.length);
  assert.ok(finalCatalog.documents.filter((document) => document.filename.startsWith("Orphan")).every((document) => document.status.startsWith("completed")));
});
