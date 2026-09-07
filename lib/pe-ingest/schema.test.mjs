import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { assertPeCollectionDataset, initializePeCollectionDatabase } = await jiti.import("./schema.ts");

function databaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-schema-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "collection.sqlite3");
}

test("creates the shared PDF and Excel schema with trigram PDF search", (t) => {
  const collectionPath = databaseFixture(t);
  initializePeCollectionDatabase(collectionPath, { datasetId: "dataset_test", name: "测试项目" });
  const database = new DatabaseSync(collectionPath);
  try {
    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name));
    for (const table of [
      "documents",
      "pdf_pages",
      "pdf_page_blocks",
      "ingest_jobs",
      "pdf_pages_fts",
      "excel_workbooks",
      "excel_sheets",
      "excel_cells",
      "excel_formula_references",
      "valuation_date_candidates",
      "metric_facts",
      "document_cache",
      "processing_jobs",
    ]) {
      assert.equal(tables.has(table), true);
    }
    assert.equal(tables.has("chunks"), false);
    const documentColumns = database.prepare("PRAGMA table_info(documents)").all().map((row) => row.name);
    assert.equal(documentColumns.includes("filename_key"), true);
    assert.equal(documentColumns.includes("logical_doc_id"), true);
    assert.equal(documentColumns.includes("version_no"), true);
    assert.equal(documentColumns.includes("is_current"), true);
    assert.equal(
      database.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get().value,
      "4",
    );
    database.prepare(
      "INSERT INTO pdf_pages_fts (page_id, doc_id, page_text) VALUES (?, ?, ?)",
    ).run("page_1", "doc_1", "营业收入同比增长，international revenue expanded");
    assert.equal(database.prepare(
      "SELECT page_id FROM pdf_pages_fts WHERE pdf_pages_fts MATCH ?",
    ).get("营业收入").page_id, "page_1");
    assert.equal(database.prepare(
      "SELECT page_id FROM pdf_pages_fts WHERE pdf_pages_fts MATCH ?",
    ).get("revenue").page_id, "page_1");
  } finally {
    database.close();
  }
});

test("rejects a populated legacy chunk database", (t) => {
  const collectionPath = databaseFixture(t);
  const legacy = new DatabaseSync(collectionPath);
  try {
    legacy.exec("CREATE TABLE chunks (id TEXT); INSERT INTO chunks VALUES ('legacy')");
  } finally {
    legacy.close();
  }
  assert.throws(
    () => initializePeCollectionDatabase(collectionPath),
    /Legacy Python Pipeline data detected/u,
  );
});

test("rejects a collection owned by a different dataset", (t) => {
  const collectionPath = databaseFixture(t);
  initializePeCollectionDatabase(collectionPath, { datasetId: "dataset_a", name: "A" });
  assert.throws(
    () => assertPeCollectionDataset(collectionPath, "dataset_b"),
    /does not match/u,
  );
});
