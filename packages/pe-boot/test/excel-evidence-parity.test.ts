import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { preparePeDocument, registerPeDocuments } from "../src/documents.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { EXCEL_TABLES, excelPython } from "../src/excel-processing.ts";
import { parseSourceId, sourceId } from "../src/source.ts";
import type { ExcelCellDetail } from "../src/tools/excel-cells.ts";
import { getPeExcelRange } from "../src/tools/excel-range.ts";
import { tracePeFormula } from "../src/tools/formula-trace.ts";
import { getPeMemoVersion, savePeMemo } from "../src/tools/memo-storage.ts";
import { savePeResearchNote } from "../src/tools/research-note-storage.ts";
import { inspectPeWorkbooks } from "../src/tools/workbook-inspect.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const directories: string[] = [];

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pe-excel-parity-"));
	directories.push(root);
	mkdirSync(join(root, "raw"));
	mkdirSync(join(root, "meta"));
	initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), {
		datasetId: "parity-dataset",
		name: "Parity",
	});
	return root;
}

function register(root: string, bytes = readFileSync(join(fixtures, "excel-parity.xlsx"))): string {
	const result = registerPeDocuments(root, "parity-dataset", [{ name: "excel-parity.xlsx", bytes }]);
	const document = result.documents[0];
	utimesSync(
		join(root, String(document.stored_path)),
		new Date("2026-08-31T00:00:00Z"),
		new Date("2026-08-31T00:00:00Z"),
	);
	return String(document.doc_id);
}

function discardCache(root: string, docId: string): void {
	rmSync(join(root, "meta/excel", docId), { recursive: true, force: true });
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	for (const table of EXCEL_TABLES) database.prepare(`DELETE FROM ${table} WHERE doc_id=?`).run(docId);
	database.prepare("DELETE FROM document_cache WHERE doc_id=?").run(docId);
	database.close();
}

afterEach(() => {
	for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Excel parity and immutable evidence on the shared PDF schema", () => {
	it("preserves every historical source value and formula without full materialization", async () => {
		const root = project();
		const docId = register(root);
		const prepared = await preparePeDocument(root, { docId });
		expect(prepared.document.status).toBe("completed_with_warnings");
		expect(prepared.warnings).toEqual([expect.stringContaining("16")]);
		const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		try {
			for (const table of ["excel_cells", "excel_formula_references", "metric_facts", "valuation_date_candidates"])
				expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE doc_id=?`).get(docId)).toEqual({
					count: 0,
				});
		} finally {
			database.close();
		}
		const expected = JSON.parse(readFileSync(join(fixtures, "excel-parity-main.json"), "utf8")) as {
			ranges: Array<{ sheet: { name: string }; cell_range: string; cells: ExcelCellDetail[] }>;
		};
		for (const previous of expected.ranges) {
			const current = getPeExcelRange(root, {
				docId,
				sheetName: previous.sheet.name,
				cellRange: previous.cell_range,
				maxCells: 1000,
			});
			const cells = current.cells as ExcelCellDetail[];
			expect(cells).toHaveLength(previous.cells.length);
			for (const oldCell of previous.cells) {
				const cell = cells.find((item) => item.cell_ref === oldCell.cell_ref);
				expect(cell, `${previous.sheet.name}!${oldCell.cell_ref}`).toBeDefined();
				for (const key of [
					"cell_ref",
					"row_index",
					"col_index",
					"raw_value",
					"numeric_value",
					"cached_value",
					"number_format",
					"is_formula",
					"formula_type",
					"formula_cache_status",
				] as const)
					expect(cell?.[key], `${previous.sheet.name}!${oldCell.cell_ref}:${key}`).toEqual(oldCell[key]);
				// A data-table object has attributes rather than an executable expression; raw_value above preserves them.
				if (oldCell.formula_type !== "data_table") expect(cell?.formula).toEqual(oldCell.formula);
				expect(parseSourceId(cell?.evidence_id ?? "")).toEqual({
					docId,
					location: { kind: "excel", sheet: previous.sheet.name, range: oldCell.cell_ref },
				});
			}
		}
		const longNote = getPeExcelRange(root, { docId, sheetName: "Valuation", cellRange: "A10" })
			.cells as ExcelCellDetail[];
		expect(longNote[0].display_value).toHaveLength(5120);
		expect(tracePeFormula(root, { docId, sheetName: "Valuation", cellRef: "B7" })).toMatchObject({
			complete: true,
			node_count: 4,
		});
		expect(inspectPeWorkbooks(root, { docId })).toMatchObject({
			workbooks: [expect.objectContaining({ sheet_count: 7, formula_count: 19 })],
		});
	}, 30_000);

	it("resolves blank ranges, old versions and legacy cells after every disposable cache is removed", async () => {
		const root = project();
		const firstId = register(root);
		const first = await preparePeDocument(root, { docId: firstId });
		const cell = (
			getPeExcelRange(root, { docId: firstId, sheetName: "Valuation", cellRange: "B3" }).cells as ExcelCellDetail[]
		)[0];
		// Existing pre-reader citations retain their durable location after disposable tables disappear.
		const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		database
			.prepare("INSERT INTO evidence_locations(evidence_id,doc_id,sheet_name,cell_range) VALUES(?,?,?,?)")
			.run(`cell:${cell.cell_id}`, firstId, "Valuation", "B3");
		database.close();
		const newFile = join(root, "next.xlsx");
		const generated = spawnSync(excelPython(), [join(fixtures, "create_excel_parity.py"), newFile, "900"], {
			encoding: "utf8",
		});
		expect(generated.status, generated.stderr).toBe(0);
		const secondId = register(root, readFileSync(newFile));
		await preparePeDocument(root, { docId: secondId });
		expect(() => getPeExcelRange(root, { docId: firstId, sheetName: "Valuation", cellRange: "B3" })).toThrow(
			"active document not found",
		);
		discardCache(root, firstId);
		const legacyId = `cell:${cell?.cell_id}`;
		const legacy = await resolvePeEvidenceSource(root, legacyId);
		expect(legacy.payload).toMatchObject({ kind: "excel", doc_id: firstId, version_no: 1, evidence_id: legacyId });
		if (legacy.payload.kind !== "excel") throw new Error("Expected Excel preview");
		expect(legacy.payload.cells.find((row) => row.cell_ref === "B3")?.numeric_value).toBe(500);
		expect(legacy.filePath).toBe(first.filePath);
		const blank = sourceId({ docId: firstId, location: { kind: "excel", sheet: "Valuation", range: "C9:D9" } });
		const preview = await resolvePeEvidenceSource(root, blank);
		expect(preview.payload).toMatchObject({ doc_id: firstId, cell_range: "C9:D9", version_no: 1 });
	}, 30_000);

	it("prepares historical citations before Memo and Note transactions and rejects modified originals", async () => {
		const root = project();
		const docId = register(root);
		const prepared = await preparePeDocument(root, { docId });
		const evidence = sourceId({ docId, location: { kind: "excel", sheet: "Valuation", range: "B7" } });
		discardCache(root, docId);
		const memo = await savePeMemo(root, {
			operation: "create",
			topic: "Versioned model",
			claims: [
				{
					section: "Conclusion",
					text: "The cached target price is 120.",
					status: "supported",
					evidenceIds: [evidence],
				},
			],
		});
		expect(memo.citation_gate).toMatchObject({ passed: true, valid_evidence_ids: [evidence] });
		expect(getPeMemoVersion(root, memo.memo_version_id).document_versions).toEqual(
			expect.arrayContaining([expect.objectContaining({ doc_id: docId, version_no: 1 })]),
		);
		discardCache(root, docId);
		const note = await savePeResearchNote(root, {
			title: "Model",
			summary: "Model facts",
			presentationMode: "text",
			contentHtml: "<html><body>Model facts</body></html>",
			evidenceIds: [evidence],
		});
		expect(note.resolved_evidence_ids).toEqual([evidence]);
		writeFileSync(prepared.filePath, "modified original");
		await expect(resolvePeEvidenceSource(root, evidence)).rejects.toThrow("Original file changed");
		const invalid = await savePeResearchNote(root, {
			title: "Modified",
			summary: "Citation audit",
			presentationMode: "text",
			contentHtml: "<html><body>Audit</body></html>",
			evidenceIds: [evidence],
		});
		expect(invalid.unresolved_evidence_ids).toEqual([evidence]);
	}, 30_000);
});
