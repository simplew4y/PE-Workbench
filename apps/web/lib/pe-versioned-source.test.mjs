import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerPeDocuments, preparePeDocument } from "@earendil-works/pe-boot/documents";
import { initializePeCollectionDatabase } from "@earendil-works/pe-boot/schema";
import { sourceId } from "@earendil-works/pe-boot/source";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolvePeEvidenceSource, PeSourceError } = await jiti.import("./pe-source-server.ts");
const python = process.env.PE_EXCEL_PYTHON || resolve(dirname(fileURLToPath(import.meta.url)),
  "../../PE-Workbench-pi/packages/pe-boot/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

test("Web resolves exact Excel versions and blank ranges after cache loss, preserving legacy cell links", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pe-versioned-source-")));
  try {
    mkdirSync(join(root, "raw"));
    mkdirSync(join(root, "meta"));
    initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"), { datasetId: "dataset", name: "Versioned" });
    const script = join(root, "fixture.py");
    writeFileSync(script, [
      "import sys",
      "from pathlib import Path",
      "from openpyxl import Workbook",
      "root = Path(sys.argv[1])",
      "for value in (2, 4):",
      "    wb = Workbook()",
      "    ws = wb.active",
      "    ws.title = '估值模型'",
      "    ws['A1'] = 'Target price'",
      "    ws['A2'] = 'Revenue'",
      "    ws['B2'] = value",
      "    ws['B2'].number_format = '0.00'",
      "    ws['C2'] = '=B2*2'",
      "    ws['D4'] = '范围边界'",
      "    wb.save(root / f'{value}.xlsx')",
      "    wb.close()",
    ].join("\n"));
    execFileSync(python, [script, root]);
    const first = registerPeDocuments(root, "dataset", [{ name: "模型.xlsx", bytes: readFileSync(join(root, "2.xlsx")) }]).documents[0];
    await preparePeDocument(root, { docId: first.doc_id });
    const location = sourceId({ docId: first.doc_id, location: { kind: "excel", sheet: "估值模型", range: "B2" } });
    const db = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
    const cellId = db.prepare("SELECT cell_id FROM excel_cells WHERE doc_id=? AND cell_ref='B2'").get(first.doc_id).cell_id;
    const factId = db.prepare("SELECT fact_id FROM metric_facts WHERE doc_id=? AND cell_ref='B2'").get(first.doc_id)?.fact_id;
    assert.ok(factId, "Fixture must contain a candidate metric fact");
    db.close();
    const second = registerPeDocuments(root, "dataset", [{ name: "模型.xlsx", bytes: readFileSync(join(root, "4.xlsx")) }]).documents[0];
    assert.equal(second.version_no, 2);
    const historical = await resolvePeEvidenceSource(root, location);
    assert.equal(historical.payload.version_no, 1);
    assert.equal(historical.payload.cells.find((cell) => cell.cell_ref === "B2").raw_value, "2");
    assert.equal(historical.payload.cells.find((cell) => cell.cell_ref === "B2").number_format, "0.00");
    const formula = historical.payload.cells.find((cell) => cell.cell_ref === "C2");
    assert.equal(formula.formula, "=B2*2");
    assert.equal(formula.formula_cache_status, "missing");
    const blank = await resolvePeEvidenceSource(root, sourceId({ docId: first.doc_id, location: { kind: "excel", sheet: "估值模型", range: "B3:C3" } }));
    assert.equal(blank.payload.cell_range, "B3:C3");
    rmSync(join(root, "meta", "excel", first.doc_id), { recursive: true, force: true });
    const cache = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
    cache.prepare("DELETE FROM excel_cells WHERE doc_id=?").run(first.doc_id);
    cache.close();
    const repaired = await resolvePeEvidenceSource(root, `cell:${cellId}`);
    assert.equal(repaired.payload.version_no, 1);
    assert.equal(repaired.payload.cells.find((cell) => cell.cell_ref === "B2").raw_value, "2");
    rmSync(join(root, "meta", "excel", first.doc_id), { recursive: true, force: true });
    const factCache = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
    factCache.prepare("DELETE FROM metric_facts WHERE doc_id=?").run(first.doc_id);
    factCache.close();
    const repairedFact = await resolvePeEvidenceSource(root, `fact:${factId}`);
    assert.equal(repairedFact.payload.version_no, 1);
    assert.equal(repairedFact.payload.cells.find((cell) => cell.cell_ref === "B2").raw_value, "2");
    const current = await resolvePeEvidenceSource(root, sourceId({ docId: second.doc_id, location: { kind: "excel", sheet: "估值模型", range: "B2" } }));
    assert.equal(current.payload.cells.find((cell) => cell.cell_ref === "B2").raw_value, "4");
    writeFileSync(join(root, first.raw_path), "modified original");
    await assert.rejects(resolvePeEvidenceSource(root, location), (error) => error instanceof PeSourceError && error.status === 409);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
