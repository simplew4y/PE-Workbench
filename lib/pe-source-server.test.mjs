import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  excelPython,
  registerPeDocuments,
  sourceId,
} from "@earendil-works/pe-boot";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { initializePeCollectionDatabase } = await jiti.import("./pe-ingest/schema.ts");
const { resolvePeEvidenceSource } = await jiti.import("./pe-source-server.ts");

function createFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-pe-source-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["raw", "meta", "generated"]) mkdirSync(join(root, directory));
  initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"), {
    datasetId: "dataset-source",
    name: "来源测试",
  });
  return root;
}

function addPdf(root) {
  const bytes = Buffer.from("%PDF-1.4\nfixture");
  writeFileSync(join(root, "raw", "阳光电源调研.pdf"), bytes);
  const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
  const now = new Date().toISOString();
  try {
    database.prepare(`
      INSERT INTO documents (
        doc_id, dataset_id, original_filename, filename_key, raw_path, sha256,
        status, page_count, parser_name, parser_version, title, brokerage,
        document_date, rating, target_price, exhibits_json, pdf_metadata_json,
        artifact_directory, document_markdown_path, layout_json_path,
        warnings_json, created_at, updated_at, file_type, source_relpath,
        file_size, readable_text_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "doc_pdf", "dataset-source", "阳光电源调研.pdf", "阳光电源调研.pdf",
      "raw/阳光电源调研.pdf", createHash("sha256").update(bytes).digest("hex"),
      "completed", 1, "pdfjs-dist", "6.3.289", "阳光电源调研", "", "", "", "",
      "[]", "{}", "meta/documents/阳光电源调研", "meta/text/阳光电源调研.md",
      "meta/documents/阳光电源调研/layout.json", "[]", now, now, "pdf",
      "阳光电源调研.pdf", bytes.byteLength, "meta/text/阳光电源调研.md",
    );
    database.prepare(`
      INSERT INTO pdf_pages (
        page_id, doc_id, page_number, page_text, page_header, role,
        role_signals_json, text_quality, quality_signals_json, width, height,
        rotation, image_paths_json, embedded_image_count,
        large_embedded_image_count, drawing_operator_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "page_pdf", "doc_pdf", 2, "第二页完整内容：储能单位盈利预计改善。",
      "阳光电源调研.pdf · p.2/2", "body", "{}", "passed", "{}", 595, 842, 0,
      "[]", 0, 0, 0,
    );
  } finally {
    database.close();
  }
}

function createWorkbook(root) {
  const sourcePath = join(root, "fixture.xlsx");
  const script = [
    "import sys",
    "from openpyxl import Workbook",
    "wb=Workbook()",
    "ws=wb.active",
    "ws.title='Forecast'",
    "ws['A1']='Revenue'",
    "ws['B1']='2026E'",
    "ws['A2']='Base'",
    "ws['B2']=500",
    "ws['A3']='Upside'",
    "ws['B3']=700",
    "ws['A4']='Total'",
    "ws['B4']='=SUM(B2:B3)'",
    "ws['B4'].number_format='0.00'",
    "wb.save(sys.argv[1])",
  ].join(";");
  const created = spawnSync(excelPython(), ["-c", script, sourcePath], { encoding: "utf8" });
  if (created.status !== 0) throw new Error(created.stderr || "Unable to create Excel fixture");
  const registered = registerPeDocuments(root, "dataset-source", [{
    name: "模型.xlsx",
    bytes: readFileSync(sourcePath),
  }]);
  return String(registered.documents[0].doc_id);
}

test("resolves page-level PDF evidence from the TypeScript Pipeline", async (t) => {
  const root = createFixture(t);
  addPdf(root);
  const source = await resolvePeEvidenceSource(root, "page:page_pdf");
  assert.equal(source.payload.kind, "pdf");
  assert.equal(source.payload.citation, "阳光电源调研.pdf p.2");
  assert.equal(source.payload.page_start, 2);
  assert.equal(source.payload.content, "第二页完整内容：储能单位盈利预计改善。");
  assert.deepEqual(source.payload.pdf_pages, [
    { page_number: 2, text: "第二页完整内容：储能单位盈利预计改善。" },
  ]);
  assert.equal(source.filePath, join(root, "raw", "阳光电源调研.pdf"));
});

test("resolves source evidence to an Excel grid with formulas", async (t) => {
  const root = createFixture(t);
  const docId = createWorkbook(root);
  const evidenceId = sourceId({ docId, sheet: "Forecast", range: "B4" });
  const source = await resolvePeEvidenceSource(root, evidenceId);
  assert.equal(source.payload.kind, "excel");
  assert.equal(source.payload.citation, "模型.xlsx Forecast!B4");
  assert.equal(source.payload.version_no, 1);
  assert.deepEqual(source.payload.grid_window, {
    row_start: 1,
    row_end: 4,
    col_start: 1,
    col_end: 2,
  });
  const formula = source.payload.cells.find((cell) => cell.cell_ref === "B4");
  assert.equal(formula.formula, "=SUM(B2:B3)");
  assert.equal(formula.number_format, "0.00");
  const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
  try {
    const document = database.prepare("SELECT raw_path FROM documents WHERE doc_id = ?").get(docId);
    assert.equal(source.filePath, join(root, document.raw_path));
  } finally {
    database.close();
  }
});

test("reports an absent legacy source instead of resolving another document", async (t) => {
  const root = createFixture(t);
  await assert.rejects(
    () => resolvePeEvidenceSource(root, "cell:cell_missing"),
    /not found|不存在/iu,
  );
});
