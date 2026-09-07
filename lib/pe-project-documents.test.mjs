import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listPeProjectDocuments } = await jiti.import("./pe-project-documents.ts");
const { createPeProject, peProjectStorePaths } = await jiti.import("./pe-project-store.ts");
const { saveParsedPeDocument } = await jiti.import("./pe-ingest/repository.ts");
const { resolvePeProjectPaths } = await jiti.import("./pe-ingest/paths.ts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-project-documents-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: "资料列表测试" }, options);
  const paths = resolvePeProjectPaths(project, peProjectStorePaths(options).registryPath);
  return { options, project, paths };
}

function parsedDocument(paths) {
  return {
    docId: "doc_internal_only",
    datasetId: paths.datasetId,
    originalFilename: "年度报告.pdf",
    rawPath: "raw/年度报告.pdf",
    sha256: "a".repeat(64),
    parserName: "pdfjs-dist",
    parserVersion: "6.3.289",
    metadata: {
      title: "年度报告",
      brokerage: "",
      documentDate: "",
      rating: "",
      targetPrice: "",
      exhibits: [],
      pdfMetadata: {},
    },
    pages: [{
      pageId: "page_internal_only",
      pageNumber: 1,
      role: "body",
      roleSignals: {
        matchedKeywords: [], numericLineRatio: 0, tableLineRatio: 0,
        embeddedImageCount: 0, largeEmbeddedImageCount: 0, drawingOperatorCount: 0,
      },
      width: 595,
      height: 842,
      rotation: 0,
      text: "测试文本",
      pageHeader: "年度报告.pdf · p.1/1",
      textQuality: "needs_ocr",
      qualitySignals: {
        characterCount: 4,
        replacementCharacterRatio: 0,
        suspiciousCharacterRatio: 0,
        readableCharacterRatio: 1,
        reasons: ["页面文本较少"],
      },
      imagePaths: ["meta/documents/年度报告/pages/page-0001@110.png"],
      imageStatistics: { embeddedImageCount: 0, largeEmbeddedImageCount: 0, drawingOperatorCount: 0 },
      blocks: [],
    }],
    artifactDirectory: "meta/documents/年度报告",
    documentMarkdownPath: "meta/text/年度报告.md",
    layoutJsonPath: "meta/documents/年度报告/layout.json",
    warnings: ["第 1 页需要 OCR"],
  };
}

test("lists indexed, running, and failed project files without exposing evidence IDs", (t) => {
  const { options, project, paths } = fixture(t);
  fs.writeFileSync(path.join(project.root, "raw", "年度报告.pdf"), "%PDF-test");
  fs.writeFileSync(path.join(project.root, "meta", "text", "年度报告.md"), "# 年度报告");
  saveParsedPeDocument(paths, parsedDocument(paths));

  fs.writeFileSync(path.join(project.root, "raw", "电话会.pdf"), "%PDF-running");
  fs.writeFileSync(path.join(project.root, "raw", "损坏文件.pdf"), "%PDF-broken");
  const database = new DatabaseSync(paths.collectionPath);
  try {
    database.prepare("UPDATE documents SET created_at = ?, updated_at = ? WHERE dataset_id = ?")
      .run("2026-09-07T10:00:00.000Z", "2026-09-07T10:00:00.000Z", project.datasetId);
    database.prepare(`
      INSERT INTO ingest_jobs (
        job_id, dataset_id, status, message, input_files_json, result_json,
        warnings_json, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "job_running",
      project.datasetId,
      "running",
      "正在解析",
      JSON.stringify([{ originalFilename: "电话会.pdf", rawPath: "raw/电话会.pdf", sha256: "b".repeat(64) }]),
      JSON.stringify({ files: [], createdCount: 0, failedCount: 0 }),
      "[]",
      "2026-09-07T10:01:00.000Z",
      "2026-09-07T10:01:01.000Z",
      null,
      "2026-09-07T10:01:01.000Z",
    );
    database.prepare(`
      INSERT INTO ingest_jobs (
        job_id, dataset_id, status, message, input_files_json, result_json,
        warnings_json, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "job_failed",
      project.datasetId,
      "failed",
      "PDF 无法解析",
      JSON.stringify([{ originalFilename: "损坏文件.pdf", rawPath: "raw/损坏文件.pdf", sha256: "c".repeat(64) }]),
      JSON.stringify({
        files: [{ originalFilename: "损坏文件.pdf", status: "failed", error: "PDF 无法解析: /home/private/input.pdf" }],
        createdCount: 0,
        failedCount: 1,
      }),
      "[]",
      "2026-09-07T10:02:00.000Z",
      "2026-09-07T10:02:01.000Z",
      "2026-09-07T10:02:02.000Z",
      "2026-09-07T10:02:02.000Z",
    );
  } finally {
    database.close();
  }

  const catalog = listPeProjectDocuments(project.datasetId, options);
  assert.deepEqual(catalog.documents.map((document) => document.filename), [
    "损坏文件.pdf",
    "电话会.pdf",
    "年度报告.pdf",
  ]);

  const indexed = catalog.documents.find((document) => document.filename === "年度报告.pdf");
  assert.equal(indexed.status, "completed_with_warnings");
  assert.equal(indexed.pageCount, 1);
  assert.equal(indexed.needsOcrPageCount, 1);
  assert.equal(indexed.rawRelativePath, "raw/年度报告.pdf");
  assert.equal(indexed.markdownRelativePath, "meta/text/年度报告.md");
  assert.equal(indexed.warningCount, 1);
  assert.equal(indexed.title, "年度报告");
  assert.equal(indexed.brokerage, undefined);
  assert.equal(indexed.documentDate, undefined);

  const running = catalog.documents.find((document) => document.filename === "电话会.pdf");
  assert.equal(running.status, "running");
  assert.equal(running.markdownRelativePath, null);

  const failed = catalog.documents.find((document) => document.filename === "损坏文件.pdf");
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.warnings, ["PDF 无法解析: [local path]"]);
  assert.doesNotMatch(JSON.stringify(catalog), /\/home\/private/u);
  assert.doesNotMatch(JSON.stringify(catalog), /doc_internal_only|page_internal_only/u);
});

test("does not return preview paths that fail workspace validation", (t) => {
  const { options, project, paths } = fixture(t);
  fs.writeFileSync(path.join(project.root, "raw", "年度报告.pdf"), "%PDF-test");
  fs.writeFileSync(path.join(project.root, "meta", "text", "年度报告.md"), "# 年度报告");
  saveParsedPeDocument(paths, parsedDocument(paths));
  const database = new DatabaseSync(paths.collectionPath);
  try {
    database.prepare("UPDATE documents SET raw_path = '../outside.pdf'").run();
  } finally {
    database.close();
  }

  const [document] = listPeProjectDocuments(project.datasetId, options).documents;
  assert.equal(document.rawRelativePath, null);
  assert.equal(document.markdownRelativePath, "meta/text/年度报告.md");
});

test("opening the document list migrates an existing v2 PDF project before reading version columns", (t) => {
  const { options, project, paths } = fixture(t);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${paths.collectionPath}${suffix}`, { force: true });
  const database = new DatabaseSync(paths.collectionPath);
  try {
    database.exec(fs.readFileSync(new URL("./pe-ingest/fixtures/pdf-schema-v2.sql", import.meta.url), "utf8"));
    database.exec("INSERT INTO schema_metadata VALUES ('pipeline_schema_version', '2', '2026-09-07')");
    database.prepare("INSERT INTO project_metadata VALUES (1, ?, ?, '2026-09-07', '2026-09-07')").run(project.datasetId, project.name);
    database.prepare(`INSERT INTO documents VALUES ('legacy-pdf', ?, 'Report.pdf', 'report.pdf', 'raw/Report.pdf', 'legacy-hash',
      'completed', 1, 'pdfjs-dist', '6.3.289', 'Report', '', '', '', '', '[]', '{}',
      'meta/documents/Report', 'meta/text/Report.md', 'meta/documents/Report/layout.json', '[]', '2026-09-07', '2026-09-07')`).run(project.datasetId);
    database.exec(`INSERT INTO pdf_pages VALUES ('legacy-page', 'legacy-pdf', 1, 'Revenue increased', 'Report.pdf p.1', 'body', '{}',
      'passed', '{}', 595, 842, 0, '[]', 0, 0, 0);
      INSERT INTO pdf_pages_fts VALUES ('legacy-page', 'legacy-pdf', 'Revenue increased');`);
  } finally { database.close(); }
  fs.writeFileSync(path.join(project.root, "raw", "Report.pdf"), "%PDF-legacy");
  fs.writeFileSync(path.join(project.root, "meta", "text", "Report.md"), "Revenue increased");
  const catalog = listPeProjectDocuments(project.datasetId, options);
  assert.equal(catalog.currentCount, 1);
  assert.equal(catalog.documents[0].filename, "Report.pdf");
  assert.equal(catalog.documents[0].pageCount, 1);
  assert.equal(catalog.documents[0].status, "completed");
  const migrated = new DatabaseSync(paths.collectionPath);
  try {
    assert.equal(migrated.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get().value, "4");
    assert.equal(migrated.prepare("SELECT doc_id FROM pdf_pages_fts WHERE pdf_pages_fts MATCH 'Revenue'").get().doc_id, "legacy-pdf");
    migrated.prepare("UPDATE documents SET deleted_at = '2026-09-08'").run();
    assert.deepEqual(listPeProjectDocuments(project.datasetId, options), { documents: [], currentCount: 0 });
    migrated.prepare("UPDATE documents SET deleted_at = NULL, lifecycle_state = 'archived'").run();
    assert.deepEqual(listPeProjectDocuments(project.datasetId, options), { documents: [], currentCount: 0 });
  } finally { migrated.close(); }
});

test("opening an empty main project initializes the current schema and missing output directories", (t) => {
  const { options, project, paths } = fixture(t);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${paths.collectionPath}${suffix}`, { force: true });
  const database = new DatabaseSync(paths.collectionPath);
  try {
    database.exec(`CREATE TABLE project_metadata (
      id INTEGER PRIMARY KEY CHECK(id = 1), dataset_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    database.prepare("INSERT INTO project_metadata VALUES (1, ?, ?, '2026-09-01', '2026-09-01')")
      .run(project.datasetId, project.name);
  } finally { database.close(); }
  fs.rmSync(paths.textPath, { recursive: true });
  fs.rmSync(paths.documentsPath, { recursive: true });
  assert.deepEqual(listPeProjectDocuments(project.datasetId, options), { documents: [], currentCount: 0 });
  assert.equal(fs.statSync(paths.textPath).isDirectory(), true);
  assert.equal(fs.statSync(paths.documentsPath).isDirectory(), true);
  const migrated = new DatabaseSync(paths.collectionPath);
  try {
    assert.equal(migrated.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get().value, "4");
    assert.equal(migrated.prepare("SELECT dataset_id FROM project_metadata WHERE id=1").get().dataset_id, project.datasetId);
  } finally { migrated.close(); }
});
