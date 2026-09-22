import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { sourceId } from "../src/source.ts";
import type { ExcelCellDetail } from "../src/tools/excel-cells.ts";
import { getPeExcelRange, peExcelRangeTool } from "../src/tools/excel-range.ts";
import { peFormulaTraceTool, tracePeFormula } from "../src/tools/formula-trace.ts";
import { peModelValidateTool, validatePeModel } from "../src/tools/model-validate.ts";
import { peValuationDateTool, resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import { locatePeValuationOutputs, peValuationOutputTool } from "../src/tools/valuation-output.ts";
import { inspectPeWorkbooks, peWorkbookInspectTool } from "../src/tools/workbook-inspect.ts";
import { workbookSourceFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
async function fixture() {
	const result = await workbookSourceFixture();
	roots.push(result.root);
	return result;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PE financial tools reading original workbooks", () => {
	it("retains the existing financial tool entry points", () => {
		expect(
			[
				peWorkbookInspectTool,
				peExcelRangeTool,
				peFormulaTraceTool,
				peValuationOutputTool,
				peValuationDateTool,
				peModelValidateTool,
			].map((tool) => tool.name),
		).toEqual([
			"pe_workbook_inspect",
			"pe_excel_range",
			"pe_formula_trace",
			"pe_valuation_output_locate",
			"pe_valuation_date_resolve",
			"pe_model_validate",
		]);
	});
	it("reads source values, formulas and citations with explicit range continuation", async () => {
		const { root, docId, datasetId } = await fixture();
		const first = getPeExcelRange(root, { docId, sheetName: "Valuation", cellRange: "A3:B7", maxCells: 2 });
		expect(first).toMatchObject({
			dataset_id: datasetId,
			matching_cell_count: 10,
			returned_cell_count: 2,
			complete: false,
			next_offset: 2,
		});
		const rest = getPeExcelRange(root, { docId, sheetName: "Valuation", cellRange: "A3:B7", offset: 2 });
		expect(rest).toMatchObject({ complete: true, next_offset: null, returned_cell_count: 8 });
		const cells = rest.cells as ExcelCellDetail[];
		expect(cells.find((cell) => cell.cell_ref === "B7")).toMatchObject({
			formula: "=B5/10",
			cached_value: "120",
			numeric_value: 120,
			number_format: '"CNY/share" 0.00',
			evidence_id: sourceId({ docId, location: { kind: "excel", sheet: "Valuation", range: "B7" } }),
		});
		expect(cells.every((cell) => !cell.unit && !cell.period && !cell.row_label)).toBe(true);
	});
	it("paginates navigation and exposes original hidden and merged structure", async () => {
		const { root, docId } = await fixture();
		const result = inspectPeWorkbooks(root, { docId, limit: 1 });
		expect(result).toMatchObject({
			selected_doc_id: docId,
			workbooks: [
				expect.objectContaining({
					section: "sheets",
					complete: false,
					next_offset: 1,
					formula_cache_status_counts: { present: 3, missing: 16 },
				}),
			],
		});
		const second = inspectPeWorkbooks(root, { docId, limit: 1, offset: 1 });
		expect(second.workbooks).toEqual([
			expect.objectContaining({
				sheets: [expect.objectContaining({ name: "Hidden assumptions", state: "veryHidden" })],
			}),
		]);
		const merged = inspectPeWorkbooks(root, { docId, sheet: "Valuation", section: "merged_ranges" });
		expect(merged.workbooks).toEqual([expect.objectContaining({ merged_ranges: ["D3:E3"], complete: true })]);
	});
	it("traces source formulas without the materialized formula or cell tables", async () => {
		const { root, docId } = await fixture();
		const trace = tracePeFormula(root, { docId, sheetName: "Valuation", cellRef: "B7" });
		expect(trace).toMatchObject({ complete: true, truncated: false, node_count: 4, edge_count: 2 });
		expect(trace.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ cell_ref: "B7", depth: 0, formula: "=B5/10" }),
				expect.objectContaining({ cell_ref: "B5", depth: 1, formula: "=SUM(B3:B4)" }),
				expect.objectContaining({ cell_ref: "B3", depth: 2, numeric_value: 500 }),
			]),
		);
		const limited = tracePeFormula(root, { docId, sheetName: "Valuation", cellRef: "B7", maxDepth: 0 });
		expect(limited).toMatchObject({ complete: false, truncated: true, node_count: 1 });
	});
	it("returns literal label matches without selecting a business output or date", async () => {
		const { root, docId } = await fixture();
		const outputs = locatePeValuationOutputs(root, { docId, query: "Target Price", topK: 1 });
		expect(outputs).toMatchObject({
			status: "search_results",
			selection_method: "source_text_search",
			search_complete: false,
			next_offset: 1,
		});
		expect(outputs).not.toHaveProperty("selected_output");
		expect(outputs.matches[0]).toMatchObject({ sheet_name: "Valuation", cell_ref: "A7", raw_value: "Target Price" });
		const next = locatePeValuationOutputs(root, { docId, query: "Target Price", offset: outputs.next_offset });
		expect(next.matches[0]).toMatchObject({ sheet_name: "Sensitivity", cell_ref: "A1" });
		const dates = resolvePeValuationDate(root, { docId, query: "Valuation Date" });
		expect(dates.valuation_date).toBeUndefined();
		expect(dates.source_cells).toEqual(
			expect.arrayContaining([expect.objectContaining({ sheet_name: "Valuation", cell_ref: "A1" })]),
		);
	});
	it("reports source cache problems separately from formula and calculation validation", async () => {
		const { root, docId, datasetId } = await fixture();
		expect(validatePeModel(root, { docId })).toMatchObject({
			dataset_id: datasetId,
			document: { doc_id: docId },
			scan_complete: true,
			formula_cache_status_counts: { present: 3, missing: 16 },
			formula_reference_validation: { status: "not_run", scope: "selected_cells" },
			valuation_output_validation: { status: "not_run" },
			valuation_date_validation: { status: "not_run" },
			calculation_validation: { status: "not_run", cached_values_recalculated: false },
			issues: expect.arrayContaining([expect.objectContaining({ code: "formula_cache_missing" })]),
		});
		expect(() => inspectPeWorkbooks(root, { datasetId: "another-dataset" })).toThrow(
			"does not match the current project dataset",
		);
	});
});
