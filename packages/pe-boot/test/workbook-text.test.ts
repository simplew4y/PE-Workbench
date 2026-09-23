import { readFileSync, rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { registerPeDocuments } from "../src/documents.ts";
import { readResearchInput } from "../src/research/pi-engine.ts";
import { enqueueResearchJob } from "../src/research/watch.ts";
import { peExcelRangeTool } from "../src/tools/excel-range.ts";
import { peFormulaTraceTool } from "../src/tools/formula-trace.ts";
import { peSourceDetailTool } from "../src/tools/source-detail.ts";
import { peValuationDateTool } from "../src/tools/valuation-date.ts";
import { peValuationOutputTool } from "../src/tools/valuation-output.ts";
import { peWorkbookInspectTool } from "../src/tools/workbook-inspect.ts";
import { peWorkbookSearchTool } from "../src/tools/workbook-search.ts";
import {
	DEFAULT_WORKBOOK_TEXT_BYTES,
	formatWorkbookCellsText,
	formatWorkbookResultText,
	formatWorkbookTraceText,
} from "../src/workbook-text.ts";
import { createDocumentProject } from "./document-fixture.ts";
import { type WorkbookFixtureCell, writeWorkbookFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function syntheticCell(index: number, formula = false) {
	const ref = `B${index + 1}`;
	return {
		doc_id: "d".repeat(40),
		dataset_id: "ds",
		original_filename: "Model.xlsx",
		file_type: "xlsx",
		version_no: 1,
		sheet_name: "IS",
		cell_ref: ref,
		row_index: index + 1,
		col_index: 2,
		value_type: formula ? "formula_standard" : "float",
		display_value: formula ? "123.5" : "42",
		raw_value: formula ? `=A${index + 1}*2` : "42",
		numeric_value: formula ? 123.5 : 42,
		formula: formula ? `=A${index + 1}*2` : null,
		cached_value: formula ? "123.5" : null,
		number_format: "#,##0.0",
		is_formula: formula ? 1 : 0,
		formula_type: formula ? "standard" : null,
		formula_cache_status: formula ? "present" : "not_applicable",
		style: {
			font_color: { type: "theme", value: 1, tint: 0 },
			bold: false,
			italic: false,
			fill_type: "solid",
			fill_foreground: { type: "rgb", value: "FFFFFF00", tint: 0 },
			fill_background: { type: "indexed", value: 64, tint: 0 },
			fill_gradient: [],
		},
		comment: null,
		metadata_json: JSON.stringify({
			sheet_state: "visible",
			hidden_row: false,
			hidden_column: false,
			merged_range: null,
			formula_metadata: {},
			conditional_formatting: false,
		}),
		evidence_id: `source:${"A".repeat(96)}`,
		markdown_citation: `[Model.xlsx IS!${ref}](#pe-source?evidence_id=source:${"A".repeat(96)})`,
		cell_id: "c".repeat(40),
	};
}

it("renders one cell as a short line instead of a ~1 KB record and keeps the evidence id", () => {
	const cells = Array.from({ length: 200 }, (_, index) => syntheticCell(index, index % 2 === 0));
	const jsonBytes = Buffer.byteLength(JSON.stringify({ cells }));
	const rendered = formatWorkbookCellsText({
		document: { filename: "Model.xlsx", doc_id: "d".repeat(40), version_no: 1 },
		sheet: { name: "IS" },
		cell_range: "B1:B200",
		cells,
		matching_cell_count: 200,
		offset: 0,
		next_offset: null,
		complete: true,
		requested_cell_count: 200,
		blank_cell_count: 0,
	});
	expect(rendered.summary.truncated).toBe(false);
	expect(rendered.summary.shown_cells).toBe(200);
	expect(jsonBytes).toBeGreaterThan(150_000);
	expect(rendered.summary.bytes).toBeLessThan(jsonBytes / 5);
	const lines = rendered.text.split("\n");
	expect(lines[0]).toBe(`# Model.xlsx | v1 | doc_id=${"d".repeat(40)}`);
	expect(lines).toContain("## IS");
	expect(lines).toContain(`B1\t123.5\t=A1*2\tfmt=#,##0.0\tsource:${"A".repeat(96)}`);
	expect(lines).toContain(`B2\t42\t-\tfmt=#,##0.0\tsource:${"A".repeat(96)}`);
	expect(rendered.text).not.toContain("markdown_citation");
	expect(rendered.text).not.toContain("fill_background");
	const withoutIds = formatWorkbookCellsText({ cells }, { includeEvidenceIds: false });
	expect(withoutIds.text).not.toContain("source:");
	expect(withoutIds.summary.bytes).toBeLessThan(rendered.summary.bytes / 2);
});

it("never shows formula text as a value when the saved result is missing or errored", () => {
	const missing = {
		...syntheticCell(0, true),
		cached_value: null,
		numeric_value: null,
		formula_cache_status: "missing",
	};
	const errored = {
		...syntheticCell(1, true),
		cached_value: "#DIV/0!",
		numeric_value: null,
		formula_cache_status: "error",
	};
	const hidden = {
		...syntheticCell(2, false),
		value_type: "str",
		numeric_value: null,
		raw_value: "Revenue\tFY24",
		display_value: "Revenue\tFY24",
		comment: { author: "Analyst", text: "check" },
		metadata_json: JSON.stringify({ hidden_row: true, merged_range: "B3:D3" }),
	};
	const text = formatWorkbookCellsText({ cells: [missing, errored, hidden] }, { includeEvidenceIds: false }).text;
	expect(text).toContain("B1\t(no saved value)\t=A1*2\tfmt=#,##0.0 cache=missing");
	expect(text).toContain("B2\t#ERROR #DIV/0!\t=A2*2\tfmt=#,##0.0 cache=error");
	expect(text).toContain('B3\t"Revenue\\tFY24"\t-\tfmt=#,##0.0 hidden_row merged=B3:D3 comment(Analyst)="check"');
});

it("cuts paginated cells at the byte budget and hands back a continuation offset", () => {
	const cells = Array.from({ length: 400 }, (_, index) => syntheticCell(index, true));
	const rendered = formatWorkbookCellsText(
		{ cells, matching_cell_count: 900, offset: 100, next_offset: 500, complete: false },
		{ maxBytes: 8_000 },
	);
	expect(rendered.summary.truncated).toBe(true);
	expect(rendered.summary.bytes).toBeLessThanOrEqual(8_000);
	expect(rendered.summary.shown_cells).toBeGreaterThan(10);
	expect(rendered.summary.shown_cells).toBeLessThan(400);
	expect(rendered.summary.next_offset).toBe(100 + rendered.summary.shown_cells);
	expect(rendered.text).toContain(`Continue with offset=${100 + rendered.summary.shown_cells}`);
	expect(rendered.text).toContain("are not blank");
	expect(rendered.text.split("\n").filter((line) => line.startsWith("B")).length).toBe(rendered.summary.shown_cells);
	expect(workbookBudgetIsDefault()).toBe(true);
});

function workbookBudgetIsDefault(): boolean {
	const rendered = formatWorkbookCellsText({
		cells: Array.from({ length: 2_000 }, (_, index) => syntheticCell(index, true)),
	});
	return rendered.summary.truncated && rendered.summary.bytes <= DEFAULT_WORKBOOK_TEXT_BYTES;
}

it("summarizes traces as nodes, edges and issues and drops edges before nodes under pressure", () => {
	const nodes = Array.from({ length: 60 }, (_, index) => ({
		...syntheticCell(index, true),
		depth: index === 0 ? 0 : 1,
	}));
	const edges = Array.from({ length: 59 }, (_, index) => ({
		source_sheet: "IS",
		source_cell_ref: "B1",
		raw_reference: `B${index + 2}`,
		reference_kind: "cell",
		parse_status: "resolved",
		target_sheet: "IS",
		target_range: `B${index + 2}`,
		destinations: [["IS", `B${index + 2}`]],
	}));
	const result = {
		document: { filename: "Model.xlsx", doc_id: "d".repeat(40), version_no: 2 },
		root: { sheet_name: "IS", cell_ref: "B1" },
		nodes,
		edges: [
			...edges,
			{
				source_sheet: "IS",
				source_cell_ref: "B1",
				raw_reference: "[1]Inputs!A1",
				reference_kind: "external_cell",
				parse_status: "external",
				external_workbook: "1",
			},
		],
		issues: [
			{ reason: "formula_cache_unavailable", sheet: "IS", cell_ref: "B5", status: "missing" },
			{
				reason: "circular_reference",
				cells: [
					{ sheet: "IS", cell_ref: "B1" },
					{ sheet: "IS", cell_ref: "B2" },
					{ sheet: "IS", cell_ref: "B1" },
				],
			},
		],
		pending_ranges: [{ sheet: "DCF", range: "C10:C20", depth: 2 }],
		pending_reads: [],
		complete: false,
		truncated: true,
	};
	const full = formatWorkbookTraceText(result, { includeEvidenceIds: false });
	expect(full.summary.truncated).toBe(false);
	expect(full.text).toContain(
		"trace upstream from IS!B1: nodes=60 edges=60 issues=2 complete=false truncated=true pending_ranges=1",
	);
	expect(full.text).toContain("B1\t123.5\t=A1*2\tfmt=#,##0.0 depth=0");
	expect(full.text).toContain("IS!B1 -> IS!B2 [cell]");
	expect(full.text).toContain("IS!B1 -> [1]Inputs!A1 [external_cell/external] external=[1]");
	expect(full.text).toContain("- formula_cache_unavailable IS!B5: missing");
	expect(full.text).toContain("- circular_reference: IS!B1 -> IS!B2 -> IS!B1");
	expect(full.text).toContain("pending_ranges");
	expect(full.text).toContain("DCF!C10:C20@d2");
	const tight = formatWorkbookTraceText(result, { includeEvidenceIds: false, maxBytes: 3_500 });
	expect(tight.summary.bytes).toBeLessThanOrEqual(3_500);
	expect(tight.text).toContain("edges omitted");
	expect(tight.text.split("\n").filter((line) => /^B\d+\t/.test(line)).length).toBeGreaterThan(5);
	expect(formatWorkbookResultText(result).text.startsWith("# Model.xlsx | v2")).toBe(true);
});

it("sends compact text to the model from every project workbook tool while details keep the full result", async () => {
	const datasetId = "text-budget";
	const root = createDocumentProject(datasetId);
	roots.push(root);
	const document = registerPeDocuments(root, datasetId, [
		{ name: "Budget.xlsx", bytes: readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url)) },
	]).documents[0];
	const docId = String(document.doc_id);
	const cells: WorkbookFixtureCell[] = [{ sheet: "Model", cell: "A1", value: "Revenue" }];
	for (let row = 2; row <= 121; row++) {
		cells.push({ sheet: "Model", cell: `A${row}`, value: `Line ${row}` });
		cells.push({ sheet: "Model", cell: `B${row}`, value: row * 10, format: "#,##0" });
		cells.push({ sheet: "Model", cell: `C${row}`, value: `=B${row}*2`, cached: row * 20 });
	}
	cells.push({ sheet: "Model", cell: "D1", value: "=SUM(C2:C121)", cached: 147600 });
	writeWorkbookFixture(root, docId, cells);
	const ctx = { cwd: root } as Parameters<typeof peExcelRangeTool.execute>[4];

	const range = await peExcelRangeTool.execute(
		"range",
		{ doc_id: docId, sheet_name: "Model", cell_range: "A1:C121", max_cells: 400 },
		undefined,
		undefined,
		ctx,
	);
	const rangeText = (range.content[0] as { text: string }).text;
	const rangeDetails = range.details as { cells: unknown[]; model_text: { bytes: number; shown_cells: number } };
	expect(rangeDetails.cells.length).toBe(361);
	expect(rangeDetails.model_text.shown_cells).toBe(361);
	expect(Buffer.byteLength(rangeText)).toBeLessThan(Buffer.byteLength(JSON.stringify(rangeDetails.cells)) / 15);
	expect(Buffer.byteLength(rangeText)).toBeLessThanOrEqual(DEFAULT_WORKBOOK_TEXT_BYTES);
	expect(rangeText).toContain("# Budget.xlsx | v1");
	expect(rangeText).toContain("range=Model!A1:C121");
	expect(rangeText).toContain("evidence ids omitted");
	expect(rangeText).toMatch(/^C2\t40\t=B2\*2\t-$/mu);
	expect(rangeText).toMatch(/^B2\t20\t-\tfmt=#,##0$/mu);
	expect(rangeText).toMatch(/^A1\t"Revenue"\t-\t-$/mu);
	expect(rangeText).not.toContain("source:");
	expect(rangeText).not.toContain("markdown_citation");
	expect(rangeText).not.toContain("font_color");

	const cited = await peExcelRangeTool.execute(
		"range",
		{
			doc_id: docId,
			ranges: [
				{ sheet: "Model", range: "C2" },
				{ sheet: "Model", range: "D1" },
			],
			include_evidence_ids: true,
			include_style: true,
		},
		undefined,
		undefined,
		ctx,
	);
	const citedText = (cited.content[0] as { text: string }).text;
	expect(citedText).toContain("ranges=Model!C2,Model!D1");
	expect(citedText).toMatch(/^C2\t40\t=B2\*2\tfont=theme:1\tsource:[A-Za-z0-9_-]+$/mu);
	expect(citedText).toMatch(/^D1\t147600\t=SUM\(C2:C121\)\tfont=theme:1\tsource:[A-Za-z0-9_-]+$/mu);
	expect(citedText).toContain("cite a cell as [Budget.xlsx <sheet>!<cell>](#pe-source?evidence_id=<evidence_id>)");
	const citedCells = (cited.details as { cells: Array<{ cell_ref: string; evidence_id: string }> }).cells;
	for (const cell of citedCells) expect(citedText).toContain(`${cell.cell_ref}\t`);
	for (const cell of citedCells) expect(citedText).toContain(cell.evidence_id);

	// With ids on for a wide range, the byte budget cuts the page and points at the continuation offset.
	const wide = await peExcelRangeTool.execute(
		"range",
		{ doc_id: docId, sheet_name: "Model", cell_range: "A1:C121", max_cells: 400, include_evidence_ids: true },
		undefined,
		undefined,
		ctx,
	);
	const wideSummary = (
		wide.details as { model_text: { truncated: boolean; shown_cells: number; next_offset?: number } }
	).model_text;
	expect(Buffer.byteLength((wide.content[0] as { text: string }).text)).toBeLessThanOrEqual(
		DEFAULT_WORKBOOK_TEXT_BYTES,
	);
	expect(wideSummary.truncated).toBe(true);
	expect(wideSummary.next_offset).toBe(wideSummary.shown_cells);
	expect((wide.content[0] as { text: string }).text).toContain(`Continue with offset=${wideSummary.shown_cells}`);

	const search = await peWorkbookSearchTool.execute(
		"search",
		{ doc_id: docId, query: "Line 1" },
		undefined,
		undefined,
		ctx,
	);
	const searchText = (search.content[0] as { text: string }).text;
	expect(searchText).toContain('query="Line 1"');
	expect(searchText).toMatch(/^A10\t"Line 10"\t-\tmatch=value\tsource:/mu);
	expect((search.details as { model_text: { truncated: boolean } }).model_text.truncated).toBe(false);

	const trace = await peFormulaTraceTool.execute(
		"trace",
		{ doc_id: docId, sheet_name: "Model", cell_ref: "D1", max_depth: 1 },
		undefined,
		undefined,
		ctx,
	);
	const traceText = (trace.content[0] as { text: string }).text;
	expect(traceText).toContain("trace upstream from Model!D1");
	expect(traceText).toMatch(/^D1\t147600\t=SUM\(C2:C121\)\tdepth=0\tsource:/mu);
	expect(traceText).toContain("Model!D1 -> Model!C2:C121 [range]");
	expect(Buffer.byteLength(traceText)).toBeLessThanOrEqual(DEFAULT_WORKBOOK_TEXT_BYTES);
	expect((trace.details as { nodes: unknown[] }).nodes.length).toBeGreaterThan(100);

	const inspect = await peWorkbookInspectTool.execute("inspect", { doc_id: docId }, undefined, undefined, ctx);
	const inspectText = (inspect.content[0] as { text: string }).text;
	expect(inspectText).toContain("# workbooks: active=1 selection_required=false");
	expect(inspectText).toContain("# Budget.xlsx | v1 | doc_id=");
	expect(inspectText).toMatch(/^\d+ "Model" visible A1:D121 cells=\d+ formulas=121/mu);
	expect(inspectText).toContain('calcPr={"calcId"');
	expect(inspectText).not.toContain("metadata_json");
	expect(inspectText).not.toContain('"sheet_name"');

	const outputs = await peValuationOutputTool.execute(
		"outputs",
		{ doc_id: docId, query: "Line 12" },
		undefined,
		undefined,
		ctx,
	);
	const outputsText = (outputs.content[0] as { text: string }).text;
	expect(outputsText).toContain('status="search_results" selection_method="source_text_search" search_complete=true');
	expect(outputsText).toMatch(/^A12\t"Line 12"\t-\tmatch=value\tsource:/mu);
	expect(outputsText).not.toContain("markdown_citation");
	expect((outputs.details as { matches: unknown[] }).matches.length).toBeGreaterThan(0);

	const dates = await peValuationDateTool.execute(
		"dates",
		{ doc_id: docId, query: "Revenue" },
		undefined,
		undefined,
		ctx,
	);
	const datesText = (dates.content[0] as { text: string }).text;
	expect(datesText).toContain('status="search_results" resolution_method="source_text_search" evidence_ids=[]');
	expect(datesText).toMatch(/^A1\t"Revenue"\t-\tmatch=value\tsource:/mu);

	const citedC2 = citedCells.find((cell) => cell.cell_ref === "C2")!;
	const detail = await peSourceDetailTool.execute(
		"detail",
		{ evidence_id: citedC2.evidence_id },
		undefined,
		undefined,
		ctx,
	);
	const detailText = (detail.content[0] as { text: string }).text;
	const detailPayload = detail.details as { cells: unknown[]; model_text: { shown_cells: number } };
	expect(detailText).toContain(`evidence_id="${citedC2.evidence_id}"`);
	expect(detailText).toContain("range=Model!C2");
	expect(detailText).toContain("grid_window=");
	expect(detailText).toMatch(/^C2\t40\t=B2\*2\t-\tsource:/mu);
	expect(detailPayload.model_text.shown_cells).toBe(detailPayload.cells.length);
	expect(Buffer.byteLength(detailText)).toBeLessThan(Buffer.byteLength(JSON.stringify(detailPayload.cells)) / 4);

	const job = enqueueResearchJob(root, datasetId, "Budget", [docId], "evidence", null);
	const research = readResearchInput(root, datasetId, job.input, { docId, sheet: "Model", range: "A1:C3" }) as Record<
		string,
		unknown
	>;
	const researchText = formatWorkbookResultText(research, { docId }).text;
	expect(researchText).toContain("# Budget.xlsx");
	expect(researchText).toMatch(/^C2\t40\t=B2\*2\t-\tsource:/mu);
	expect(researchText).toContain("note: Stored values only");
}, 60_000);
