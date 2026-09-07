import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPeProject, peProjectStorePaths } = await jiti.import("../pe-project-store.ts");
const { ensureDirectoryWithin, resolvePeProjectPaths } = await jiti.import("./paths.ts");
const {
  commitParsedPeDocument,
  findPeDocumentByFilename,
  findPeDocumentByHash,
  saveParsedPeDocument,
} = await jiti.import("./repository.ts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-repository-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: "版本测试" }, options);
  return resolvePeProjectPaths(project, peProjectStorePaths(options).registryPath);
}

function parsed(paths, suffix, pageIds = [`page_${suffix}`]) {
  return {
    docId: `doc_${suffix}`,
    datasetId: paths.datasetId,
    originalFilename: "report.pdf",
    rawPath: `raw/report_${suffix}.pdf`,
    sha256: suffix.padEnd(64, "0"),
    parserName: "pdfjs-dist",
    parserVersion: "6.3.289",
    metadata: {
      title: "报告", brokerage: "", documentDate: "", rating: "", targetPrice: "",
      exhibits: [], pdfMetadata: {},
    },
    pages: pageIds.map((pageId, index) => ({
      pageId,
      pageNumber: index + 1,
      role: "body",
      roleSignals: {
        matchedKeywords: [], numericLineRatio: 0, tableLineRatio: 0, disclosureDensity: 0,
        embeddedImageCount: 0, largeEmbeddedImageCount: 0, drawingOperatorCount: 0,
      },
      width: 595,
      height: 842,
      rotation: 0,
      text: `营业收入 version ${suffix}`,
      pageHeader: "report.pdf",
      textQuality: "passed",
      qualitySignals: {
        characterCount: 10, replacementCharacterRatio: 0,
        suspiciousCharacterRatio: 0, readableCharacterRatio: 1, reasons: [],
      },
      imagePaths: ["meta/documents/report/pages/page-0001@110.png"],
      imageStatistics: { embeddedImageCount: 0, largeEmbeddedImageCount: 0, drawingOperatorCount: 0 },
      blocks: [],
    })),
    artifactDirectory: "meta/documents/report",
    documentMarkdownPath: "meta/text/report.md",
    layoutJsonPath: "meta/documents/report/layout.json",
    warnings: [],
  };
}

test("stores one document per filename and keeps stable internal IDs", (t) => {
  const paths = fixture(t);
  saveParsedPeDocument(paths, parsed(paths, "one"));
  assert.equal(
    findPeDocumentByHash(paths.collectionPath, paths.datasetId, "one".padEnd(64, "0")).docId,
    "doc_one",
  );
  assert.equal(
    findPeDocumentByFilename(paths.collectionPath, paths.datasetId, "REPORT.PDF").docId,
    "doc_one",
  );
  assert.throws(
    () => saveParsedPeDocument(paths, parsed(paths, "two")),
    /name or content already indexed/u,
  );

  const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM documents").get().count, 1);
    assert.equal(database.prepare(
      "SELECT page_id FROM pdf_pages_fts WHERE pdf_pages_fts MATCH '营业收入' AND doc_id = ?",
    ).get("doc_one").page_id, "page_one");
  } finally {
    database.close();
  }
});

test("rolls back database rows and removes final artifacts when registration fails", (t) => {
  const paths = fixture(t);
  const stagingRoot = ensureDirectoryWithin(paths.metaPath, ".ingest-staging");
  ensureDirectoryWithin(paths.metaPath, "documents");
  const jobDirectory = path.join(stagingRoot, "0123456789abcdef");
  const stagingDocument = path.join(jobDirectory, "doc_broken");
  fs.mkdirSync(stagingDocument, { recursive: true });
  fs.writeFileSync(path.join(stagingDocument, "document.md"), "partial");
  assert.throws(
    () => commitParsedPeDocument(
      paths,
      stagingDocument,
      parsed(paths, "broken", ["page_same", "page_same"]),
    ),
    /UNIQUE constraint failed/u,
  );
  assert.equal(fs.existsSync(path.join(paths.documentsPath, "doc_broken")), false);
  assert.equal(fs.existsSync(path.join(paths.documentsPath, "report")), false);
  assert.equal(fs.existsSync(path.join(paths.textPath, "report.md")), false);
  const database = new DatabaseSync(paths.collectionPath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM documents").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pdf_pages").get().count, 0);
  } finally {
    database.close();
  }
});
