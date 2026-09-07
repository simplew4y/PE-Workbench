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
import { getPeExcelRange } from "../src/tools/excel-range.ts";
import { tracePeFormula } from "../src/tools/formula-trace.ts";
import { getPeMemoVersion, savePeMemo } from "../src/tools/memo-storage.ts";
import { validatePeModel } from "../src/tools/model-validate.ts";
import { savePeResearchNote } from "../src/tools/research-note-storage.ts";
import { resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import { inspectPeWorkbooks } from "../src/tools/workbook-inspect.ts";
import { financialParitySnapshot, withoutInferredFinancialContext } from "./financial-parity-support.ts";

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
	it("excludes only inferred context while detecting changes to original evidence", () => {
		const cell = {
			cell_ref: "B7",
			raw_value: "=B5/10",
			formula: "=B5/10",
			cached_value: "120",
			numeric_value: 120,
			number_format: '"CNY/share" 0.00',
			evidence_id: "source:original",
			row_label: "Target Price",
			period: "2026",
			unit: "per_share",
		};
		const corrected = { ...cell, period: "", unit: "CNY/share", unit_context: { status: "inferred" } };
		expect(withoutInferredFinancialContext(corrected)).toEqual(withoutInferredFinancialContext(cell));
		for (const [field, value] of Object.entries({
			cell_ref: "B8",
			raw_value: "=B5/100",
			formula: "=B5/100",
			cached_value: "12",
			numeric_value: 12,
			number_format: "0.0%",
			evidence_id: "source:different",
			row_label: "Current Price",
		})) {
			expect(withoutInferredFinancialContext({ ...corrected, [field]: value }), field).not.toEqual(
				withoutInferredFinancialContext(cell),
			);
		}
	});

	it("preserves original values, formulas and evidence while inferred annotations evolve", async () => {
		const root = project();
		const docId = register(root);
		const prepared = await preparePeDocument(root, { docId });
		const expectedWarnings = [
			"16 formula cell(s) have missing or unusable cached values; formulas were not recalculated.",
			"2 formula reference(s) could not be resolved completely.",
		];
		expect(prepared.warnings).toEqual(expectedWarnings);
		expect(prepared.document.status).toBe("completed_with_warnings");
		expect(inspectPeWorkbooks(root, { docId }).workbooks).toEqual([
			expect.objectContaining({ doc_id: docId, status: "completed_with_warnings" }),
		]);
		const readable = readFileSync(prepared.readablePath, "utf8");
		expect(readable.split("\n").filter((line) => line.startsWith("Warning: "))).toEqual(
			expectedWarnings.map((warning) => `Warning: ${warning}`),
		);
		const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		const candidates = database
			.prepare(
				"SELECT evidence_id,sheet_name,cell_ref FROM valuation_date_candidates WHERE doc_id=? AND evidence_id IS NOT NULL",
			)
			.all(docId);
		database.close();
		expect(candidates).toHaveLength(6);
		for (const candidate of candidates) {
			const evidence = String(candidate.evidence_id);
			expect(parseSourceId(evidence)).toEqual({
				docId,
				location: { kind: "excel", sheet: candidate.sheet_name, range: candidate.cell_ref },
			});
			const preview = await resolvePeEvidenceSource(root, evidence);
			expect(preview.payload).toMatchObject({
				kind: "excel",
				doc_id: docId,
				sheet_name: candidate.sheet_name,
				cell_range: candidate.cell_ref,
			});
		}
		const actual = financialParitySnapshot(root, docId, tools, prepared.readablePath, expectedWarnings);
		// Generated with original parser AND original tools at a2870ae2902e1cc52343b9e94e227601839f7fa6.
		const expected = JSON.parse(readFileSync(join(fixtures, "excel-parity-main.json"), "utf8")) as {
			readable_sha256: string;
			tables: Record<string, { count: number; sha256: string }>;
			inspect: unknown;
			ranges: unknown[];
			outputs: { candidates: Record<string, unknown>[]; cross_check_nodes: Record<string, unknown>[] };
			traces: { root: { sheet_name: string; cell_ref: string } }[];
			dates: { output_context: { sheet_name: string; cell_ref: string; valuation_output_candidate_id: string } }[];
		};
		// This digest covers every original cell's raw value, cache, formula,
		// location and citation. Never regenerate it for a semantic parser change.
		expect(actual.readable_sha256).toBe(expected.readable_sha256);
		const tables = actual.tables as Record<string, { count: number; sha256: string }>;
		for (const table of [
			"excel_sheets",
			"excel_regions",
			"excel_defined_names",
			"excel_formula_references",
			"valuation_date_candidates",
		]) {
			expect(tables[table], table).toEqual(expected.tables[table]);
		}
		expect(tables.excel_workbooks.count).toBe(expected.tables.excel_workbooks.count);
		expect(tables.excel_cells.count).toBe(expected.tables.excel_cells.count);
		// The old excel_cells/metric_facts hashes embed the incorrect inferred
		// periods and units. Compare all source fields rather than blessing those
		// errors or replacing the large historical snapshot.
		expect(withoutInferredFinancialContext(actual.ranges)).toEqual(withoutInferredFinancialContext(expected.ranges));
		expect(withoutInferredFinancialContext(actual.inspect)).toEqual(
			withoutInferredFinancialContext(expected.inspect),
		);
		const outputs = locatePeValuationOutputs(root, { docId });
		for (const candidate of expected.outputs.candidates) {
			const current = outputs.candidates.find(
				(item) => item.sheet_name === candidate.sheet_name && item.cell_ref === candidate.cell_ref,
			);
			expect(current, `${candidate.sheet_name}!${candidate.cell_ref}`).toBeDefined();
			if (!current) throw new Error("Missing original output candidate");
			for (const field of [
				"candidate_id",
				"sheet_name",
				"cell_ref",
				"display_value",
				"numeric_value",
				"formula",
				"cached_value",
				"formula_cache_status",
				"number_format",
				"evidence_ids",
				"citations",
				"markdown_citations",
			]) {
				expect(current[field as keyof typeof current], field).toEqual(candidate[field]);
			}
		}
		for (const node of expected.outputs.cross_check_nodes) {
			expect(outputs.cross_check_nodes).toEqual(expect.arrayContaining([expect.objectContaining(node)]));
		}
		// Trace and date evidence are checked against explicit historical roots;
		// a broader output inventory is allowed to change which root ranks first.
		const traces = expected.traces.map(({ root: node }) =>
			tools.tracePeFormula(root, { docId, sheetName: node.sheet_name, cellRef: node.cell_ref }),
		);
		expect(withoutInferredFinancialContext(traces)).toEqual(withoutInferredFinancialContext(expected.traces));
		const dates = expected.dates.map(({ output_context: context }) =>
			tools.resolvePeValuationDate(root, {
				docId,
				outputSheet: context.sheet_name,
				outputCellRef: context.cell_ref,
				outputCandidateId: context.valuation_output_candidate_id,
			}),
		);
		expect(withoutInferredFinancialContext(dates)).toEqual(withoutInferredFinancialContext(expected.dates));
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
