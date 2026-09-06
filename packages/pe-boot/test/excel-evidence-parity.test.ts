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
import { sourceId } from "../src/source.ts";
import { getPeExcelRange } from "../src/tools/excel-range.ts";
import { tracePeFormula } from "../src/tools/formula-trace.ts";
import { getPeMemoVersion, savePeMemo } from "../src/tools/memo-storage.ts";
import { validatePeModel } from "../src/tools/model-validate.ts";
import { savePeResearchNote } from "../src/tools/research-note-storage.ts";
import { resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import { inspectPeWorkbooks } from "../src/tools/workbook-inspect.ts";
import { financialParitySnapshot } from "./financial-parity-support.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const directories: string[] = [];
const tools = {
	getPeExcelRange,
	tracePeFormula,
	validatePeModel,
	resolvePeValuationDate,
	locatePeValuationOutputs,
	inspectPeWorkbooks,
};

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
	it("matches every parser field and six main tool outputs on a real OOXML workbook", async () => {
		const root = project();
		const docId = register(root);
		const prepared = await preparePeDocument(root, { docId });
		const actual = financialParitySnapshot(root, docId, tools, prepared.readablePath);
		// Generated with original parser AND original tools at a2870ae2902e1cc52343b9e94e227601839f7fa6.
		const expected: unknown = JSON.parse(readFileSync(join(fixtures, "excel-parity-main.json"), "utf8"));
		expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
	}, 30_000);

	it("resolves blank ranges, old versions and legacy cells after every disposable cache is removed", async () => {
		const root = project();
		const firstId = register(root);
		const first = await preparePeDocument(root, { docId: firstId });
		const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		const cell = database
			.prepare("SELECT cell_id FROM excel_cells WHERE doc_id=? AND sheet_name='Valuation' AND cell_ref='B3'")
			.get(firstId);
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
