import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sourceId } from "../src/source.ts";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { peDocumentOpenTool } from "../src/tools/document-open.ts";
import { getPeExcelRange, peExcelRangeTool } from "../src/tools/excel-range.ts";
import { peFormulaTraceTool, tracePeFormula } from "../src/tools/formula-trace.ts";
import { peModelValidateTool, validatePeModel } from "../src/tools/model-validate.ts";
import { peSourceDetailTool } from "../src/tools/source-detail.ts";
import { peValuationDateTool, resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import {
	locatePeValuationOutputs,
	peValuationOutputTool,
	valuationOutputCandidateId,
} from "../src/tools/valuation-output.ts";
import { inspectPeWorkbooks, peWorkbookInspectTool } from "../src/tools/workbook-inspect.ts";

const temporaryDirectories: string[] = [];

function createDatasetFixture(datasetId = "dataset-1"): string {
	const root = mkdtempSync(join(tmpdir(), "pe-boot-retrieval-"));
	temporaryDirectories.push(root);
	mkdirSync(join(root, "meta"));
	mkdirSync(join(root, "raw"));
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	database.exec(`
		CREATE TABLE documents (
			doc_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			logical_doc_id TEXT,
			original_filename TEXT NOT NULL,
			source_relpath TEXT,
			file_type TEXT NOT NULL,
			doc_type TEXT,
			document_date TEXT,
			parser_name TEXT,
			parser_version TEXT,
			status TEXT NOT NULL DEFAULT 'completed',
			version_no INTEGER NOT NULL DEFAULT 1,
			is_current INTEGER NOT NULL DEFAULT 1,
			lifecycle_state TEXT NOT NULL DEFAULT 'active',
			deleted_at TEXT
		);
		CREATE TABLE metric_facts (
			fact_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			metric_name TEXT NOT NULL,
			metric_alias TEXT,
			period TEXT,
			value_text TEXT,
			value_numeric REAL,
			unit TEXT,
			sheet_name TEXT NOT NULL,
			cell_ref TEXT NOT NULL,
			source_range TEXT,
			formula TEXT,
			confidence REAL,
			fact_status TEXT NOT NULL DEFAULT 'candidate',
			quality_status TEXT NOT NULL DEFAULT 'review_required',
			quality_issues_json TEXT
		);
		CREATE TABLE excel_workbooks (
			workbook_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			workbook_type TEXT NOT NULL,
			sheet_count INTEGER NOT NULL,
			visible_sheet_count INTEGER NOT NULL,
			formula_count INTEGER NOT NULL,
			non_empty_cell_count INTEGER NOT NULL,
			formula_density REAL NOT NULL,
			metadata_json TEXT
		);
		CREATE TABLE excel_sheets (
			sheet_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			sheet_index INTEGER NOT NULL,
			sheet_name TEXT NOT NULL,
			sheet_role TEXT NOT NULL,
			sheet_state TEXT,
			used_range TEXT,
			row_count INTEGER NOT NULL,
			col_count INTEGER NOT NULL,
			non_empty_cell_count INTEGER NOT NULL,
			formula_count INTEGER NOT NULL,
			formula_density REAL NOT NULL
		);
		CREATE TABLE excel_cells (
			cell_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			sheet_name TEXT NOT NULL,
			cell_ref TEXT NOT NULL,
			row_index INTEGER NOT NULL,
			col_index INTEGER NOT NULL,
			display_value TEXT,
			raw_value TEXT,
			numeric_value REAL,
			formula TEXT,
			cached_value TEXT,
			number_format TEXT,
			row_label TEXT,
			col_label TEXT,
			period TEXT,
			unit TEXT,
			is_formula INTEGER NOT NULL DEFAULT 0,
			formula_type TEXT,
			formula_cache_status TEXT NOT NULL DEFAULT 'not_applicable'
		);
		CREATE TABLE excel_formula_references (
			reference_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			source_cell_id TEXT NOT NULL,
			source_sheet TEXT NOT NULL,
			source_cell_ref TEXT NOT NULL,
			reference_index INTEGER NOT NULL,
			raw_reference TEXT NOT NULL,
			reference_kind TEXT NOT NULL,
			target_sheet TEXT,
			target_range TEXT,
			defined_name TEXT,
			external_workbook TEXT,
			parse_status TEXT NOT NULL,
			metadata_json TEXT
		);
		CREATE TABLE excel_defined_names (
			defined_name_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			name TEXT NOT NULL,
			scope_sheet TEXT,
			name_type TEXT,
			attr_text TEXT,
			hidden INTEGER NOT NULL DEFAULT 0,
			metadata_json TEXT
		);
		CREATE TABLE valuation_date_candidates (
			candidate_id TEXT PRIMARY KEY,
			schema_version TEXT NOT NULL DEFAULT '1.0',
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			normalized_date TEXT,
			raw_text TEXT NOT NULL,
			role TEXT NOT NULL,
			source_type TEXT NOT NULL,
			evidence_id TEXT,
			sheet_name TEXT,
			cell_ref TEXT,
			row_index INTEGER,
			col_index INTEGER,
			nearby_label TEXT,
			parse_method TEXT NOT NULL,
			date_precision TEXT NOT NULL,
			is_forecast INTEGER NOT NULL DEFAULT 0,
			priority_score REAL NOT NULL,
			confidence REAL NOT NULL,
			rejection_reason TEXT,
			metadata_json TEXT
		);
	`);

	const insertDocument = database.prepare(
		"INSERT INTO documents (doc_id, dataset_id, original_filename, source_relpath, file_type, doc_type, document_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	insertDocument.run("doc-xlsx", datasetId, "模型.xlsx", "模型.xlsx", "xlsx", "valuation_model", "2026-08-02");
	database
		.prepare("UPDATE documents SET logical_doc_id = ?, parser_name = ?, parser_version = ? WHERE doc_id = 'doc-xlsx'")
		.run("valuation-model", "openpyxl", "3.1.5");
	database
		.prepare(
			"INSERT INTO excel_workbooks (workbook_id, dataset_id, doc_id, workbook_type, sheet_count, visible_sheet_count, formula_count, non_empty_cell_count, formula_density, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"workbook-xlsx",
			datasetId,
			"doc-xlsx",
			"xlsx",
			1,
			1,
			2,
			11,
			2 / 11,
			'{"date_epoch":"1899-12-30T00:00:00","external_link_count":0}',
		);
	database
		.prepare(
			"INSERT INTO excel_sheets (sheet_id, dataset_id, doc_id, sheet_index, sheet_name, sheet_role, sheet_state, used_range, row_count, col_count, non_empty_cell_count, formula_count, formula_density) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("sheet-forecast", datasetId, "doc-xlsx", 1, "Forecast", "forecast", "visible", "A1:D7", 7, 4, 11, 2, 2 / 11);
	database
		.prepare(
			"INSERT INTO metric_facts (fact_id, dataset_id, doc_id, metric_name, metric_alias, period, value_text, value_numeric, unit, sheet_name, cell_ref, source_range, formula, confidence, fact_status, quality_status, quality_issues_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"fact-revenue",
			datasetId,
			"doc-xlsx",
			"Revenue",
			"sales",
			"2026E",
			"1200",
			1200,
			"CNYm",
			"Forecast",
			"C5",
			"Forecast!C5",
			"=SUM(C3:C4)",
			0.9,
			"candidate",
			"candidate_complete",
			'["metric_name_inferred_from_nearest_left_label"]',
		);
	const insertCell = database.prepare(
		"INSERT INTO excel_cells (cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index, display_value, raw_value, numeric_value, formula, cached_value, number_format, row_label, col_label, period, unit, is_formula, formula_type, formula_cache_status) VALUES (?, ?, 'doc-xlsx', 'Forecast', ?, 5, ?, ?, ?, ?, ?, ?, ?, 'Revenue', ?, '2026E', 'CNYm', ?, ?, ?)",
	);
	insertCell.run(
		"cell-b5",
		datasetId,
		"B5",
		2,
		"Revenue",
		"Revenue",
		null,
		null,
		null,
		"General",
		"2025A",
		0,
		null,
		"not_applicable",
	);
	insertCell.run(
		"cell-c5",
		datasetId,
		"C5",
		3,
		"1200",
		"=SUM(C3:C4)",
		1200,
		"=SUM(C3:C4)",
		"1200",
		"#,##0.0",
		"2026E",
		1,
		"standard",
		"present",
	);
	insertCell.run(
		"cell-d5",
		datasetId,
		"D5",
		4,
		"1400",
		"1400",
		1400,
		null,
		null,
		"#,##0.0",
		"2027E",
		0,
		null,
		"not_applicable",
	);
	const insertFormulaInput = database.prepare(
		"INSERT INTO excel_cells (cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index, display_value, raw_value, numeric_value, row_label, col_label, period, unit, is_formula) VALUES (?, ?, 'doc-xlsx', 'Forecast', ?, ?, 3, ?, ?, ?, 'Revenue component', '2026E', '2026E', 'CNYm', 0)",
	);
	insertFormulaInput.run("cell-c3", datasetId, "C3", 3, "500", "500", 500);
	insertFormulaInput.run("cell-c4", datasetId, "C4", 4, "700", "700", 700);
	const insertContextCell = database.prepare(
		`INSERT INTO excel_cells (
			cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
			display_value, raw_value, number_format, row_label, col_label, period, unit,
			is_formula, formula_cache_status
		) VALUES (?, ?, 'doc-xlsx', 'Forecast', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 'not_applicable')`,
	);
	insertContextCell.run("cell-a1", datasetId, "A1", 1, 1, "Valuation Date", "Valuation Date", "General", null, null);
	insertContextCell.run(
		"cell-b1",
		datasetId,
		"B1",
		1,
		2,
		"2026-08-31",
		"2026-08-31",
		"yyyy-mm-dd",
		"Valuation Date",
		null,
	);
	insertContextCell.run(
		"cell-a2",
		datasetId,
		"A2",
		2,
		1,
		"Forecast horizon",
		"Forecast horizon",
		"General",
		null,
		null,
	);
	insertContextCell.run("cell-b2", datasetId, "B2", 2, 2, "2030E", "2030E", "General", "Forecast horizon", null);
	insertContextCell.run("cell-a7", datasetId, "A7", 7, 1, "Target Price", "Target Price", "General", null, null);
	database
		.prepare(
			`INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, numeric_value, formula, cached_value,
				number_format, row_label, col_label, period, unit, is_formula,
				formula_type, formula_cache_status
			) VALUES (
				'cell-b7', ?, 'doc-xlsx', 'Forecast', 'B7', 7, 2,
				'120', '=C5/10', 120, '=C5/10', '120',
				'0.00', 'Target Price', NULL, '2026E', 'CNY/share', 1,
				'standard', 'present'
			)`,
		)
		.run(datasetId);
	database
		.prepare(
			"INSERT INTO excel_formula_references (reference_id, dataset_id, doc_id, source_cell_id, source_sheet, source_cell_ref, reference_index, raw_reference, reference_kind, target_sheet, target_range, parse_status) VALUES (?, ?, 'doc-xlsx', 'cell-c5', 'Forecast', 'C5', 0, 'C3:C4', 'range', 'Forecast', 'C3:C4', 'resolved')",
		)
		.run("reference-c5-0", datasetId);
	database
		.prepare(
			"INSERT INTO excel_formula_references (reference_id, dataset_id, doc_id, source_cell_id, source_sheet, source_cell_ref, reference_index, raw_reference, reference_kind, target_sheet, target_range, parse_status) VALUES ('reference-b7-0', ?, 'doc-xlsx', 'cell-b7', 'Forecast', 'B7', 0, 'C5', 'cell', 'Forecast', 'C5', 'resolved')",
		)
		.run(datasetId);
	const insertDateCandidate = database.prepare(
		`INSERT INTO valuation_date_candidates (
			candidate_id, dataset_id, doc_id, normalized_date, raw_text, role,
			source_type, evidence_id, sheet_name, cell_ref, row_index, col_index,
			nearby_label, parse_method, date_precision, is_forecast, priority_score,
			confidence, rejection_reason, metadata_json
		) VALUES (?, ?, 'doc-xlsx', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	insertDateCandidate.run(
		"date-valuation",
		datasetId,
		"2026-08-31",
		"2026-08-31",
		"valuation_date",
		"workbook_cell",
		sourceId({ docId: "doc-xlsx", location: { kind: "excel", sheet: "Forecast", range: "B1" } }),
		"Forecast",
		"B1",
		1,
		2,
		"Valuation Date",
		"excel_date",
		"day",
		0,
		0.98,
		0.98,
		null,
		'{"role_method":"explicit_label:valuation date","assertion_status":"affirmed","date_extraction_rules_version":"3"}',
	);
	insertDateCandidate.run(
		"date-forecast",
		datasetId,
		null,
		"2030E",
		"forecast_period",
		"workbook_cell",
		sourceId({ docId: "doc-xlsx", location: { kind: "excel", sheet: "Forecast", range: "B2" } }),
		"Forecast",
		"B2",
		2,
		2,
		"Forecast horizon",
		"forecast_period_token",
		"period",
		1,
		0,
		0.99,
		"forecast_period_is_not_valuation_date",
		'{"role_method":"forecast_suffix"}',
	);
	insertDateCandidate.run(
		"date-file-modified",
		datasetId,
		"2027-09-06",
		"2027-09-06T12:00:00+00:00",
		"file_modified_at",
		"file_metadata",
		null,
		null,
		null,
		null,
		null,
		null,
		"workbook_property",
		"day",
		0,
		0.02,
		0.5,
		"workbook_property_cannot_verify_valuation_date",
		'{"role_method":"workbook_property"}',
	);
	database.close();
	return root;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PE financial tools", () => {
	it("exposes pe-prefixed tool names", () => {
		expect(peDocumentOpenTool.name).toBe("pe_document_open");
		expect(peSourceDetailTool.name).toBe("pe_source_detail");
		expect(peWorkbookInspectTool.name).toBe("pe_workbook_inspect");
		expect(peExcelRangeTool.name).toBe("pe_excel_range");
		expect(peFormulaTraceTool.name).toBe("pe_formula_trace");
		expect(peValuationOutputTool.name).toBe("pe_valuation_output_locate");
		expect(peValuationDateTool.name).toBe("pe_valuation_date_resolve");
		expect(peModelValidateTool.name).toBe("pe_model_validate");
		expect(buildPeSystemPrompt("/workspace")).toContain(
			'Only status=verified supports the phrase "verified valuation date"',
		);
		expect(buildPeSystemPrompt("/workspace")).toContain(
			"preserve ambiguous candidates instead of choosing the first label match",
		);
	});

	it("reads one exact Excel range without lexical search", () => {
		const root = createDatasetFixture();
		const result = getPeExcelRange(root, {
			docId: "doc-xlsx",
			sheetName: "Forecast",
			cellRange: "B5:D5",
		});

		expect(result).toMatchObject({
			dataset_id: "dataset-1",
			document: { doc_id: "doc-xlsx", logical_doc_id: "valuation-model", version_no: 1 },
			sheet: { name: "Forecast", state: "visible", used_range: "A1:D7" },
			citation: "模型.xlsx Forecast!B5:D5",
			requested_cell_count: 3,
			matching_cell_count: 3,
			returned_cell_count: 3,
			truncated: false,
			cells: expect.arrayContaining([expect.objectContaining({ cell_ref: "C5", formula_cache_status: "present" })]),
		});
	});

	it("inspects the active workbook before selecting model cells", () => {
		const root = createDatasetFixture();
		const result = inspectPeWorkbooks(root);

		expect(result).toMatchObject({
			dataset_id: "dataset-1",
			active_workbook_count: 1,
			selection_required: false,
			selected_doc_id: "doc-xlsx",
			workbooks: [
				expect.objectContaining({
					doc_id: "doc-xlsx",
					formula_cache_status_counts: { present: 2 },
					valuation_date_candidate_index_available: true,
					valuation_date_candidate_role_counts: {
						valuation_date: 1,
						forecast_period: 1,
						file_modified_at: 1,
					},
					distinct_valuation_date_candidate_count: 1,
					hidden_sheet_count: 0,
					sheets: [expect.objectContaining({ name: "Forecast", used_range: "A1:D7" })],
				}),
			],
		});
	});

	it("traces a formula upstream through a bounded range", () => {
		const root = createDatasetFixture();
		const result = tracePeFormula(root, {
			docId: "doc-xlsx",
			sheetName: "Forecast",
			cellRef: "C5",
		});

		expect(result).toMatchObject({
			dataset_id: "dataset-1",
			doc_id: "doc-xlsx",
			root: { sheet_name: "Forecast", cell_ref: "C5" },
			direction: "upstream",
			complete: true,
			truncated: false,
			node_count: 3,
			edge_count: 1,
			issues: [],
			nodes: expect.arrayContaining([
				expect.objectContaining({ cell_ref: "C5", depth: 0, formula: "=SUM(C3:C4)" }),
				expect.objectContaining({ cell_ref: "C3", depth: 1, numeric_value: 500 }),
				expect.objectContaining({ cell_ref: "C4", depth: 1, numeric_value: 700 }),
			]),
			edges: [
				expect.objectContaining({
					source_cell_ref: "C5",
					raw_reference: "C3:C4",
					target_cell_ids: ["cell-c3", "cell-c4"],
				}),
			],
		});
	});

	it("selects one explainable valuation-output candidate before resolving dates", () => {
		const root = createDatasetFixture();
		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });
		const expectedCandidateId = valuationOutputCandidateId("doc-xlsx", "Forecast", "B7");

		expect(result).toMatchObject({
			schema_version: "1.0",
			dataset_id: "dataset-1",
			document: { doc_id: "doc-xlsx", filename: "模型.xlsx" },
			status: "selected",
			selection_method: "explainable_rule_score",
			selected_candidate_id: expectedCandidateId,
			selected_output: {
				candidate_id: expectedCandidateId,
				semantic_role: "target_price",
				sheet_name: "Forecast",
				cell_ref: "B7",
				evidence_id: sourceId({ docId: "doc-xlsx", location: { kind: "excel", sheet: "Forecast", range: "B7" } }),
			},
			conflicting_candidate_ids: [],
			conflicting_outputs: [],
			candidate_count: 1,
			returned_candidate_count: 1,
			candidates: [
				expect.objectContaining({
					candidate_id: expectedCandidateId,
					semantic_role: "target_price",
					rank: 1,
					sheet_name: "Forecast",
					cell_ref: "B7",
					label: "Target Price",
					numeric_value: 120,
					formula: "=C5/10",
					formula_trace: expect.objectContaining({ structurally_complete: true, node_count: 4 }),
				}),
			],
		});
		expect(result.candidates[0].score).toBeGreaterThanOrEqual(0.62);
		expect(result.candidates[0].features.map((feature) => feature.code)).toEqual(
			expect.arrayContaining([
				"semantic_label_target_price",
				"formula_output",
				"per_share_unit_or_format",
				"near_explicit_valuation_date",
			]),
		);
		expect(result.answer_contract).toContain("not that its cached value or valuation logic was recalculated");
	});

	it("recognizes an equity-value divided by shares formula signature", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE excel_cells
			SET display_value = '120', raw_value = '=B9/B10', numeric_value = 120,
			    formula = '=B9/B10', cached_value = '120'
			WHERE cell_id = 'cell-b7';
			DELETE FROM excel_formula_references WHERE source_cell_id = 'cell-b7';
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, number_format, is_formula, formula_cache_status
			) VALUES
				('cell-a9', 'dataset-1', 'doc-xlsx', 'Forecast', 'A9', 9, 1,
				 'Equity Value', 'Equity Value', 'General', 0, 'not_applicable'),
				('cell-a10', 'dataset-1', 'doc-xlsx', 'Forecast', 'A10', 10, 1,
				 'Diluted Shares', 'Diluted Shares', 'General', 0, 'not_applicable');
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, numeric_value, number_format, row_label, unit,
				is_formula, formula_cache_status
			) VALUES
				('cell-b9', 'dataset-1', 'doc-xlsx', 'Forecast', 'B9', 9, 2,
				 '1200', '1200', 1200, '0.00', 'Equity Value', 'CNYm', 0, 'not_applicable'),
				('cell-b10', 'dataset-1', 'doc-xlsx', 'Forecast', 'B10', 10, 2,
				 '10', '10', 10, '0.00', 'Diluted Shares', 'm shares', 0, 'not_applicable');
			INSERT INTO excel_formula_references (
				reference_id, dataset_id, doc_id, source_cell_id, source_sheet, source_cell_ref,
				reference_index, raw_reference, reference_kind, target_sheet, target_range, parse_status
			) VALUES
				('reference-b7-equity', 'dataset-1', 'doc-xlsx', 'cell-b7', 'Forecast', 'B7',
				 0, 'B9', 'cell', 'Forecast', 'B9', 'resolved'),
				('reference-b7-shares', 'dataset-1', 'doc-xlsx', 'cell-b7', 'Forecast', 'B7',
				 1, 'B10', 'cell', 'Forecast', 'B10', 'resolved');
		`);
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });

		expect(result.status).toBe("selected");
		expect(result.candidates[0].features).toContainEqual(
			expect.objectContaining({ code: "equity_value_divided_by_shares_signature", weight: 0.16 }),
		);
	});

	it("locates a Chinese target-price label with a per-share unit", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE excel_cells
			SET display_value = '目标价（元/股）', raw_value = '目标价（元/股）'
			WHERE cell_id = 'cell-a7';
			UPDATE excel_cells SET row_label = '目标价(元/股)', unit = 'CNY/share'
			WHERE cell_id = 'cell-b7';
		`);
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });

		expect(result).toMatchObject({
			status: "selected",
			selected_output: {
				semantic_role: "target_price",
				sheet_name: "Forecast",
				cell_ref: "B7",
			},
		});
		expect(result.candidates[0].features.map((feature) => feature.code)).toContain("per_share_unit_or_format");
	});

	it("uses current price and upside as cross-checks without promoting them to primary outputs", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, number_format, is_formula, formula_cache_status
			) VALUES
				('cell-a6', 'dataset-1', 'doc-xlsx', 'Forecast', 'A6', 6, 1,
				 'Current Price', 'Current Price', 'General', 0, 'not_applicable');
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, numeric_value, number_format, row_label, unit,
				is_formula, formula_cache_status
			) VALUES
				('cell-b6', 'dataset-1', 'doc-xlsx', 'Forecast', 'B6', 6, 2,
				 '100', '100', 100, '0.00', 'Current Price', 'CNY/share', 0, 'not_applicable');
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, number_format, is_formula, formula_cache_status
			) VALUES
				('cell-a8', 'dataset-1', 'doc-xlsx', 'Forecast', 'A8', 8, 1,
				 'Upside', 'Upside', 'General', 0, 'not_applicable');
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, numeric_value, formula, cached_value, number_format,
				row_label, unit, is_formula, formula_type, formula_cache_status
			) VALUES
				('cell-b8', 'dataset-1', 'doc-xlsx', 'Forecast', 'B8', 8, 2,
				 '20%', '=B7/B6-1', 0.2, '=B7/B6-1', '0.2', '0.0%',
				 'Upside', '%', 1, 'standard', 'present');
			INSERT INTO excel_formula_references (
				reference_id, dataset_id, doc_id, source_cell_id, source_sheet, source_cell_ref,
				reference_index, raw_reference, reference_kind, target_sheet, target_range, parse_status
			) VALUES
				('reference-b8-0', 'dataset-1', 'doc-xlsx', 'cell-b8', 'Forecast', 'B8',
				 0, 'B7', 'cell', 'Forecast', 'B7', 'resolved'),
				('reference-b8-1', 'dataset-1', 'doc-xlsx', 'cell-b8', 'Forecast', 'B8',
				 1, 'B6', 'cell', 'Forecast', 'B6', 'resolved');
		`);
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });

		expect(result.status).toBe("selected");
		expect(result.candidates[0]).toMatchObject({
			sheet_name: "Forecast",
			cell_ref: "B7",
			referenced_by_upside: true,
			upside_links: [
				expect.objectContaining({
					upside_cell_ref: "B8",
					current_price_cell_ids: ["cell-b6"],
					consistent: true,
				}),
			],
		});
		expect(result.candidates[0].features.map((feature) => feature.code)).toEqual(
			expect.arrayContaining(["referenced_by_upside", "upside_arithmetic_consistent"]),
		);
		expect(result.cross_check_nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "current_price", cell_ref: "B6" }),
				expect.objectContaining({ role: "upside", cell_ref: "B8" }),
			]),
		);
		expect(result.candidates.map((candidate) => candidate.cell_ref)).not.toContain("B6");
		expect(result.candidates.map((candidate) => candidate.cell_ref)).not.toContain("B8");
	});

	it("preserves ambiguity between similarly supported valuation outputs", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, number_format, is_formula, formula_cache_status
			) VALUES
				('cell-a8', 'dataset-1', 'doc-xlsx', 'Forecast', 'A8', 8, 1,
				 'Target Price', 'Target Price', 'General', 0, 'not_applicable');
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, numeric_value, formula, cached_value, number_format,
				row_label, period, unit, is_formula, formula_type, formula_cache_status
			) VALUES
				('cell-b8', 'dataset-1', 'doc-xlsx', 'Forecast', 'B8', 8, 2,
				 '130', '=C5/9.23', 130, '=C5/9.23', '130', '0.00',
				 'Target Price', '2026E', 'CNY/share', 1, 'standard', 'present');
			INSERT INTO excel_formula_references (
				reference_id, dataset_id, doc_id, source_cell_id, source_sheet, source_cell_ref,
				reference_index, raw_reference, reference_kind, target_sheet, target_range, parse_status
			) VALUES
				('reference-b8-0', 'dataset-1', 'doc-xlsx', 'cell-b8', 'Forecast', 'B8',
				 0, 'C5', 'cell', 'Forecast', 'C5', 'resolved');
		`);
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });

		expect(result.status).toBe("ambiguous");
		expect(result.selected_candidate_id).toBeUndefined();
		expect(result.conflicting_candidate_ids.sort()).toEqual(
			[
				valuationOutputCandidateId("doc-xlsx", "Forecast", "B7"),
				valuationOutputCandidateId("doc-xlsx", "Forecast", "B8"),
			].sort(),
		);
		expect(result.conflicting_outputs.map((candidate) => candidate.cell_ref).sort()).toEqual(["B7", "B8"]);
	});

	it("uses a defined name as output evidence and down-ranks sensitivity cells", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE excel_cells SET row_label = NULL WHERE cell_id = 'cell-b7';
			UPDATE excel_cells SET display_value = 'Conclusion', raw_value = 'Conclusion' WHERE cell_id = 'cell-a7';
			INSERT INTO excel_defined_names (
				defined_name_id, dataset_id, doc_id, name, hidden, metadata_json
			) VALUES (
				'name-target-price', 'dataset-1', 'doc-xlsx', 'Primary_Target_Price', 0,
				'{"destinations":[["Forecast","$B$7"]]}'
			);
			INSERT INTO excel_sheets (
				sheet_id, dataset_id, doc_id, sheet_index, sheet_name, sheet_role, sheet_state,
				used_range, row_count, col_count, non_empty_cell_count, formula_count, formula_density
			) VALUES (
				'sheet-sensitivity', 'dataset-1', 'doc-xlsx', 2, 'Sensitivity', 'sensitivity', 'visible',
				'A1:B1', 1, 2, 2, 1, 0.5
			);
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, number_format, is_formula, formula_cache_status
			) VALUES
				('cell-sens-a1', 'dataset-1', 'doc-xlsx', 'Sensitivity', 'A1', 1, 1,
				 'Target Price', 'Target Price', 'General', 0, 'not_applicable');
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, numeric_value, formula, cached_value, number_format,
				row_label, unit, is_formula, formula_type, formula_cache_status
			) VALUES
				('cell-sens-b1', 'dataset-1', 'doc-xlsx', 'Sensitivity', 'B1', 1, 2,
				 '125', '=125', 125, '=125', '125', '0.00',
				 'Target Price', 'CNY/share', 1, 'standard', 'present');
		`);
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });
		const primary = result.candidates.find((candidate) => candidate.cell_ref === "B7");
		const sensitivity = result.candidates.find(
			(candidate) => candidate.sheet_name === "Sensitivity" && candidate.cell_ref === "B1",
		);

		expect(result.status).toBe("selected");
		expect(primary).toMatchObject({
			candidate_id: valuationOutputCandidateId("doc-xlsx", "Forecast", "B7"),
			label_source: "defined_name",
			defined_names: ["Primary_Target_Price"],
		});
		expect(sensitivity?.features).toContainEqual(
			expect.objectContaining({ code: "sensitivity_context_penalty", weight: -0.25 }),
		);
		expect(primary?.score).toBeGreaterThan(sensitivity?.score ?? 1);
	});

	it("never auto-selects a sensitivity-grid cell as the primary output", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE excel_cells
			SET display_value = 'Current Price', raw_value = 'Current Price'
			WHERE cell_id = 'cell-a7';
			UPDATE excel_cells SET row_label = 'Current Price' WHERE cell_id = 'cell-b7';
			INSERT INTO excel_sheets (
				sheet_id, dataset_id, doc_id, sheet_index, sheet_name, sheet_role, sheet_state,
				used_range, row_count, col_count, non_empty_cell_count, formula_count, formula_density
			) VALUES (
				'sheet-sensitivity', 'dataset-1', 'doc-xlsx', 2, 'Sensitivity', 'sensitivity', 'visible',
				'A1:B1', 1, 2, 2, 1, 0.5
			);
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, number_format, is_formula, formula_cache_status
			) VALUES
				('cell-sens-a1', 'dataset-1', 'doc-xlsx', 'Sensitivity', 'A1', 1, 1,
				 'Target Price', 'Target Price', 'General', 0, 'not_applicable');
			INSERT INTO excel_cells (
				cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
				display_value, raw_value, numeric_value, formula, cached_value, number_format,
				row_label, unit, is_formula, formula_type, formula_cache_status
			) VALUES
				('cell-sens-b1', 'dataset-1', 'doc-xlsx', 'Sensitivity', 'B1', 1, 2,
				 '125', '=125', 125, '=125', '125', '0.00',
				 'Target Price', 'CNY/share', 1, 'standard', 'present');
		`);
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });

		expect(result.status).toBe("ambiguous");
		expect(result.selected_output).toBeUndefined();
		expect(result.conflicting_outputs).toContainEqual(
			expect.objectContaining({ sheet_name: "Sensitivity", cell_ref: "B1" }),
		);
		expect(result.warnings).toContain(
			"A sensitivity-grid cell cannot be auto-selected as the primary valuation output",
		);
	});

	it("returns missing when the workbook exposes only current-price cross-checks", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE excel_cells
			SET display_value = 'Current Price', raw_value = 'Current Price'
			WHERE cell_id = 'cell-a7';
			UPDATE excel_cells SET row_label = 'Current Price' WHERE cell_id = 'cell-b7';
		`);
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });

		expect(result).toMatchObject({
			status: "missing",
			candidate_count: 0,
			candidates: [],
		});
		expect(result.selected_candidate_id).toBeUndefined();
		expect(result.cross_check_nodes).toContainEqual(
			expect.objectContaining({ role: "current_price", cell_ref: "B7" }),
		);
	});

	it("discloses a missing formula graph without awarding an endpoint feature", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("DROP TABLE excel_formula_references");
		database.close();

		const result = locatePeValuationOutputs(root, { docId: "doc-xlsx" });

		expect(result.status).toBe("selected");
		expect(result.warnings).toContain(
			"Formula-reference index is unavailable; candidates cannot receive lineage or upside checks",
		);
		expect(result.candidates[0].formula_trace).toBeUndefined();
		expect(result.candidates[0].features.map((feature) => feature.code)).not.toContain("formula_graph_endpoint");
	});

	it("verifies an explicitly labeled valuation date in the selected output context", () => {
		const root = createDatasetFixture();
		const outputCandidateId = valuationOutputCandidateId("doc-xlsx", "Forecast", "B7");
		const result = resolvePeValuationDate(root, {
			docId: "doc-xlsx",
			outputSheet: "Forecast",
			outputCellRef: "B7",
			outputCandidateId,
		});

		expect(result).toMatchObject({
			schema_version: "1.0",
			dataset_id: "dataset-1",
			document: { doc_id: "doc-xlsx", filename: "模型.xlsx", document_date: "2026-08-02" },
			status: "verified",
			valuation_date: "2026-08-31",
			selected_role: "valuation_date",
			selected_candidate_ids: ["date-valuation"],
			conflicting_candidate_ids: [],
			evidence_ids: [sourceId({ docId: "doc-xlsx", location: { kind: "excel", sheet: "Forecast", range: "B1" } })],
			primary_output_node_id: outputCandidateId,
			output_context: {
				sheet_name: "Forecast",
				cell_ref: "B7",
				valuation_output_candidate_id: outputCandidateId,
				valuation_output_status: "confirmed",
				valuation_output_role: "target_price",
				valuation_output_label: "Target Price",
				formula_trace_complete: true,
			},
		});
		expect(result.candidates).toContainEqual(
			expect.objectContaining({
				candidate_id: "date-forecast",
				is_forecast: true,
			}),
		);
		expect(
			result.candidates.find((candidate) => candidate.candidate_id === "date-forecast")?.normalized_date,
		).toBeUndefined();
		expect(result.valuation_date).not.toBe("2027-09-06");
		expect(result.warnings).toContain(
			"documents.document_date is filename-derived and was not treated as valuation-date evidence",
		);
	});

	it.each([
		["rejected evidence", "2026-08-31", "day", "date_text_could_not_be_normalized", "workbook_cell"],
		["year precision", "2026", "year", null, "workbook_cell"],
		["fabricated full date with year precision", "2026-01-01", "year", null, "workbook_cell"],
		["invalid calendar date", "2025-02-30", "day", null, "workbook_cell"],
		["filename evidence", "2026-08-31", "day", null, "filename"],
	])("excludes %s even when metadata fallback is enabled", (_label, value, precision, rejection, source) => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("DELETE FROM valuation_date_candidates WHERE candidate_id <> 'date-valuation'");
		database
			.prepare(
				"UPDATE valuation_date_candidates SET normalized_date = ?, date_precision = ?, rejection_reason = ?, source_type = ?",
			)
			.run(value, precision, rejection, source);
		database.close();

		const result = resolvePeValuationDate(root, { docId: "doc-xlsx", allowMetadataFallback: true });
		expect(result.status).toBe("missing");
		expect(result.valuation_date).toBeUndefined();
		expect(result.selected_candidate_ids).toEqual([]);
	});

	it("does not trace formulas when only forecast and metadata dates remain", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			DELETE FROM valuation_date_candidates WHERE candidate_id = 'date-valuation';
			DROP TABLE excel_formula_references;
		`);
		database.close();

		const result = resolvePeValuationDate(root, {
			docId: "doc-xlsx",
			outputSheet: "Forecast",
			outputCellRef: "B7",
		});
		expect(result.status).toBe("missing");
		expect(result.output_context).toMatchObject({
			formula_trace_status: "not_run",
			formula_trace_complete: false,
			formula_trace_issue_codes: [],
		});
		expect(result.warnings).toContain(
			"Formula tracing was not run because no eligible workbook valuation-date candidate exists",
		);
	});

	it.each([
		["negated", "valuation_date", "workbook_cell"],
		["unconfirmed", "valuation_date", "workbook_cell"],
		["negated", "valuation_date", "defined_name"],
		["unconfirmed", "valuation_date", "defined_name"],
		["negated", "market_price_date", "workbook_cell"],
		["unconfirmed", "market_price_date", "workbook_cell"],
	])("excludes %s %s from %s even if its rejection reason is missing", (assertion, role, source) => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("DELETE FROM valuation_date_candidates WHERE candidate_id <> 'date-valuation'");
		database
			.prepare("UPDATE valuation_date_candidates SET role = ?, source_type = ?, metadata_json = ?")
			.run(
				role,
				source,
				JSON.stringify({ role_method: "explicit_label:valuation date", assertion_status: assertion }),
			);
		database.close();

		const result = resolvePeValuationDate(root, {
			docId: "doc-xlsx",
			outputSheet: "Forecast",
			outputCellRef: "B7",
			allowMetadataFallback: true,
		});
		expect(result.status).toBe("missing");
		expect(result.valuation_date).toBeUndefined();
		expect(result.selected_candidate_ids).toEqual([]);
		expect(result.related_dates.market_price_date.status).toBe("missing");
		expect(result.output_context?.formula_trace_status).toBe("not_run");
		expect(result.candidates).toContainEqual(
			expect.objectContaining({
				candidate_id: "date-valuation",
				normalized_date: "2026-08-31",
				assertion_status: assertion,
				markdown_citation: expect.stringContaining("Forecast!B1"),
			}),
		);
		expect(result.warnings).toContain(
			`1 ${assertion} date candidate(s) were retained for review but excluded from date selection`,
		);
		expect(result.answer_contract).toContain("review evidence only, never selected dates");
	});

	it("does not identify a rejected related date", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE valuation_date_candidates
			SET role = 'market_price_date', rejection_reason = 'multiple_dates_require_review'
			WHERE candidate_id = 'date-valuation';
		`);
		database.close();

		const result = resolvePeValuationDate(root, { docId: "doc-xlsx" });
		expect(result.status).toBe("missing");
		expect(result.related_dates.market_price_date.status).toBe("missing");
	});

	it("requires the explicit label and output proximity on the same date candidate", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE valuation_date_candidates SET row_index = 100, cell_ref = 'B100'
			WHERE candidate_id = 'date-valuation';
			UPDATE excel_cells SET row_index = 100, cell_ref = 'B100' WHERE cell_id = 'cell-b1';
			INSERT INTO valuation_date_candidates (
				candidate_id, dataset_id, doc_id, normalized_date, raw_text, role, source_type,
				sheet_name, cell_ref, row_index, col_index, parse_method, date_precision,
				priority_score, confidence, metadata_json
			) VALUES (
				'weak-nearby', 'dataset-1', 'doc-xlsx', '2026-08-31', '2026-08-31',
				'valuation_date', 'workbook_cell', 'Forecast', 'B6', 6, 2,
				'year_first_text', 'day', 0.66, 0.68, '{"role_method":"generic_as_of_label"}'
			);
		`);
		database.close();

		const result = resolvePeValuationDate(root, {
			docId: "doc-xlsx",
			outputSheet: "Forecast",
			outputCellRef: "B7",
		});
		expect(result.status).toBe("inferred");
	});

	it("rejects a valuation-date output candidate ID that does not match its cell", () => {
		const root = createDatasetFixture();

		expect(() =>
			resolvePeValuationDate(root, {
				docId: "doc-xlsx",
				outputSheet: "Forecast",
				outputCellRef: "B7",
				outputCandidateId: "wrong-candidate-id",
			}),
		).toThrow("output_candidate_id does not match Forecast!B7");
	});

	it("does not claim a verified valuation date without an output context", () => {
		const root = createDatasetFixture();
		const result = resolvePeValuationDate(root, { docId: "doc-xlsx" });

		expect(result).toMatchObject({
			status: "inferred",
			valuation_date: "2026-08-31",
			resolution_method: "valuation_date_candidate_without_complete_output_context",
		});
		expect(result.confidence).toBeLessThan(0.9);
	});

	it("does not verify a date against a non-valuation output cell", () => {
		const root = createDatasetFixture();
		const result = resolvePeValuationDate(root, {
			docId: "doc-xlsx",
			outputSheet: "Forecast",
			outputCellRef: "C5",
		});

		expect(result).toMatchObject({
			status: "inferred",
			valuation_date: "2026-08-31",
			output_context: {
				valuation_output_status: "unconfirmed",
				formula_trace_complete: true,
			},
		});
		expect(result.warnings).toContain(
			"The supplied output cell was not confirmed as a valuation output; date status cannot be verified",
		);
	});

	it("returns ambiguous instead of selecting the later equally supported valuation date", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database
			.prepare(
				`INSERT INTO valuation_date_candidates (
					candidate_id, dataset_id, doc_id, normalized_date, raw_text, role,
					source_type, evidence_id, sheet_name, cell_ref, row_index, col_index,
					nearby_label, parse_method, date_precision, is_forecast, priority_score,
					confidence, rejection_reason, metadata_json
				) VALUES (
					'date-conflict', 'dataset-1', 'doc-xlsx', '2026-09-30', '2026-09-30',
					'valuation_date', 'workbook_cell', NULL, 'Forecast', 'D1', 1, 4,
					'Valuation Date', 'excel_date', 'day', 0, 0.98, 0.98, NULL,
					'{"role_method":"explicit_label:valuation date"}'
				)`,
			)
			.run();
		database.close();

		const result = resolvePeValuationDate(root, { docId: "doc-xlsx" });

		expect(result.status).toBe("ambiguous");
		expect(result.valuation_date).toBeUndefined();
		expect(result.selected_candidate_ids).toEqual([]);
		expect(result.conflicting_candidate_ids.sort()).toEqual(["date-conflict", "date-valuation"]);
	});

	it("keeps financial cutoff and file timestamps separate from valuation date", () => {
		const root = createDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database
			.prepare(
				`UPDATE valuation_date_candidates
				 SET role = 'financial_data_as_of', priority_score = 0.82,
				     metadata_json = '{"role_method":"explicit_label:financial data as of"}'
				 WHERE candidate_id = 'date-valuation'`,
			)
			.run();
		database.close();

		const strictResult = resolvePeValuationDate(root, { docId: "doc-xlsx" });
		expect(strictResult.status).toBe("missing");
		expect(strictResult.valuation_date).toBeUndefined();
		expect(strictResult.related_dates.financial_data_as_of).toMatchObject({
			status: "identified",
			date: "2026-08-31",
		});

		const fallbackResult = resolvePeValuationDate(root, {
			docId: "doc-xlsx",
			allowMetadataFallback: true,
		});
		expect(fallbackResult).toMatchObject({
			status: "inferred",
			valuation_date: "2027-09-06",
			selected_role: "file_modified_at",
		});
		expect(fallbackResult.confidence).toBeLessThan(0.9);
	});

	it("separates structural validation from workbook recalculation", () => {
		const root = createDatasetFixture();
		const result = validatePeModel(root, { docId: "doc-xlsx" });

		expect(result).toMatchObject({
			dataset_id: "dataset-1",
			document: { doc_id: "doc-xlsx", filename: "模型.xlsx" },
			structural_status: "pass",
			error_count: 0,
			warning_count: 0,
			issues: [],
			formula_cache_status_counts: { present: 2 },
			formula_reference_status_counts: { resolved: 2 },
			reference_kind_counts: { cell: 1, range: 1 },
			metric_quality_status_counts: { candidate_complete: 1 },
			valuation_output_validation: {
				status: "not_run",
				tool: "pe_valuation_output_locate",
				requires_selected_doc_id: true,
			},
			valuation_date_validation: {
				status: "not_run",
				tool: "pe_valuation_date_resolve",
				requires_selected_output_context: true,
			},
			calculation_validation: {
				status: "not_run",
				engine: null,
				cached_values_recalculated: false,
			},
		});
	});

	it("rejects a dataset ID that does not match the current workspace", () => {
		const root = createDatasetFixture();
		expect(() => inspectPeWorkbooks(root, { datasetId: "another-dataset" })).toThrow(
			"does not match the current project dataset",
		);
	});
});
