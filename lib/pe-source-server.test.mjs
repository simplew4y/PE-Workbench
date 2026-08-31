import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolvePeEvidenceSource } = await jiti.import("./pe-source-server.ts");

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-pe-source-"));
  mkdirSync(join(root, "meta"));
  mkdirSync(join(root, "raw"));
  writeFileSync(join(root, "raw", "访谈.pdf"), "%PDF-1.4\nfixture");
  const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
  database.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, original_filename TEXT NOT NULL,
      source_relpath TEXT, file_type TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1,
      lifecycle_state TEXT NOT NULL DEFAULT 'active', deleted_at TEXT
    );
    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, doc_id TEXT NOT NULL,
      content TEXT NOT NULL, content_type TEXT NOT NULL, title_path TEXT
    );
    CREATE TABLE chunk_locations (
      chunk_id TEXT NOT NULL, location_index INTEGER NOT NULL, page_start INTEGER,
      page_end INTEGER, sheet_name TEXT, cell_range TEXT
    );
    CREATE TABLE pdf_pages (
      dataset_id TEXT NOT NULL, doc_id TEXT NOT NULL, page_number INTEGER NOT NULL, text TEXT NOT NULL
    );
    CREATE TABLE excel_cells (
      cell_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, doc_id TEXT NOT NULL,
      sheet_name TEXT NOT NULL, cell_ref TEXT NOT NULL, row_index INTEGER NOT NULL,
      col_index INTEGER NOT NULL, display_value TEXT, raw_value TEXT, formula TEXT,
      row_label TEXT, col_label TEXT, period TEXT, unit TEXT
    );
  `);
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, 1, 'active', NULL)")
    .run("doc-1", "dataset-1", "访谈.pdf", "访谈.pdf", "pdf");
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, 1, 'active', NULL)")
    .run("doc-2", "dataset-1", "模型.xlsx", "模型.xlsx", "xlsx");
  database.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)")
    .run("chunk-1", "dataset-1", "doc-1", "储能业务盈利修复。", "pdf_page", "访谈 > p.2");
  database.prepare("INSERT INTO chunk_locations VALUES (?, 0, 2, 2, NULL, NULL)")
    .run("chunk-1");
  database.prepare("INSERT INTO pdf_pages VALUES (?, ?, ?, ?)")
    .run("dataset-1", "doc-1", 2, "第二页原文：储能业务盈利修复。");
  database.prepare("INSERT INTO excel_cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "cell-1",
      "dataset-1",
      "doc-2",
      "Forecast",
      "C5",
      5,
      3,
      "1200",
      "=SUM(C3:C4)",
      "=SUM(C3:C4)",
      "Revenue",
      "2026E",
      "2026E",
      "CNYm",
    );
  database.close();
  return root;
}

test("resolves a PDF evidence ID inside the current PE workspace", () => {
  const root = createFixture();
  try {
    const source = resolvePeEvidenceSource(root, "chunk:chunk-1");
    assert.equal(source.payload.kind, "pdf");
    assert.equal(source.payload.citation, "访谈.pdf p.2");
    assert.equal(source.payload.page_start, 2);
    assert.equal(source.filePath, join(root, "raw", "访谈.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves an Excel evidence ID to readable values and formulas", () => {
  const root = createFixture();
  try {
    const source = resolvePeEvidenceSource(root, "cell:cell-1");
    assert.equal(source.payload.kind, "excel");
    assert.equal(source.payload.citation, "模型.xlsx Forecast!C5");
    assert.deepEqual(source.payload.grid_window, {
      row_start: 1,
      row_end: 12,
      col_start: 1,
      col_end: 12,
    });
    assert.deepEqual(
      source.payload.cells.map((cell) => ({
        cell_ref: cell.cell_ref,
        display_value: cell.display_value,
        formula: cell.formula,
      })),
      [{ cell_ref: "C5", display_value: "1200", formula: "=SUM(C3:C4)" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
