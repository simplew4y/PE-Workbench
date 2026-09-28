import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildPeValuationReport,
	type PeValuationReportOptions,
	type ReportFactRequest,
} from "../src/tools/valuation-report.ts";
import { createDocumentProject } from "./document-fixture.ts";
import { type WorkbookFixtureCell, writeWorkbookFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
const labels: Record<number, [string, string]> = {
	2: ["Revenue", "EURm"],
	3: ["Gross margin", "%"],
	4: ["Tax rate", "%"],
	5: ["Diluted EPS", "EUR/share"],
	6: ["Target P/E", "x"],
	7: ["Net asset value per share", "EUR/share"],
	8: ["EPS unspecified", "per_share"],
	9: ["Weighted Average Shares (Fully Diluted)", "share_count_unspecified_scale"],
};
const periods: Record<string, string> = { B: "2023A", C: "2024A", D: "2026E", E: "2027E" };

function fixture(changes: WorkbookFixtureCell[] = []): string {
	const root = createDocumentProject("report-test");
	roots.push(root);
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	database
		.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES('model','report-test','report.xlsx','xlsx','completed','now','now')",
		)
		.run();
	for (const sheet of ["Statements", "Valuation"])
		database
			.prepare(
				"INSERT INTO excel_sheets(sheet_id,dataset_id,doc_id,sheet_index,sheet_name,sheet_role,sheet_state,used_range,row_count,col_count,non_empty_cell_count,formula_count,formula_density) VALUES(?,'report-test','model',1,?,'worksheet','visible','A1:H10',10,8,30,2,0.1)",
			)
			.run(sheet, sheet);
	database.close();
	const cells: WorkbookFixtureCell[] = [];
	const add = (cell: string, value: string | number, format = "General") =>
		cells.push({ sheet: "Statements", cell, value, format });
	for (const [column, period] of Object.entries(periods)) add(`${column}1`, period);
	for (const [row, [label, unit]] of Object.entries(labels)) {
		add(`A${row}`, label);
		add(`H${row}`, unit);
	}
	add("B2", 10000);
	add("C2", 9000);
	add("B3", 0.72, "0.0%");
	add("C3", 0.7, "0.0%");
	add("D4", 0.28);
	add("E4", 28);
	add("D5", 5);
	add("D6", 30);
	add("E6", 30);
	add("F6", 30);
	add("D7", 8);
	add("D8", 5);
	add("D9", 104.93);
	cells.push(
		{ sheet: "Valuation", cell: "A4", value: "Target Price" },
		{ sheet: "Valuation", cell: "B4", value: "=5*30", cached: 150 },
		{ sheet: "Valuation", cell: "A5", value: "Current Price" },
		{ sheet: "Valuation", cell: "B5", value: 125 },
		{ sheet: "Valuation", cell: "H4", value: "EUR/share" },
		{ sheet: "Valuation", cell: "H5", value: "EUR/share" },
	);
	writeWorkbookFixture(root, "model", [
		...cells.filter((cell) => !changes.some((change) => change.sheet === cell.sheet && change.cell === cell.cell)),
		...changes,
	]);
	return root;
}

function request(id: string, cell: string): ReportFactRequest {
	const column = cell[0],
		row = Number(cell.slice(1));
	const [label, unit] = labels[row];
	const period = periods[column];
	return {
		id,
		sheet_name: "Statements",
		cell_ref: cell,
		expected_label: label,
		expected_unit: unit,
		...(period ? { expected_period: period } : {}),
		context: {
			label: { sheet: "Statements", cell: `A${row}`, text: label },
			unit: { sheet: "Statements", cell: `H${row}`, text: unit },
			...(period ? { period: { sheet: "Statements", cell: `${column}1`, text: period } } : {}),
		},
	};
}
function options(facts: ReportFactRequest[]): PeValuationReportOptions {
	return {
		docId: "model",
		scope: "focused",
		facts,
		calculations: [],
		sections: [{ title: "核验结果", fact_ids: facts.map((fact) => fact.id) }],
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reports from original workbook facts", () => {
	it.each(["label", "period", "unit"] as const)("blocks an incorrect %s source quote", (kind) => {
		const fact = request("revenue", "B2");
		fact.context![kind]!.text = "not the source text";
		const result = buildPeValuationReport(fixture(), options([fact]));
		expect(result.status).toBe("blocked");
		expect(result.issues.join(" ")).toContain("does not match");
	});

	it("converts units using the agent's sourced interpretation and preserves source citations", () => {
		const fact = { ...request("revenue", "B2"), display_unit: "EUR_100m" };
		const result = buildPeValuationReport(fixture(), options([fact]));
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.rendered_report).toContain("100.00 亿EUR");
		expect(result.rendered_report).toContain("2023A");
		expect(result.rendered_report).toContain("#pe-source?evidence_id=source%3A");
		expect(buildPeValuationReport(fixture(), options([{ ...fact, display_unit: "USDm" }])).status).toBe("blocked");
	});

	it("computes growth and percentage-point changes from compatible sourced periods", () => {
		const input = options([
			request("before", "B2"),
			request("after", "C2"),
			request("margin_before", "B3"),
			request("margin_after", "C3"),
		]);
		input.calculations = [
			{ id: "growth", operation: "growth", left: "before", right: "after" },
			{ id: "margin", operation: "change", left: "margin_before", right: "margin_after" },
		];
		input.sections[0].fact_ids.push("growth", "margin");
		const result = buildPeValuationReport(fixture(), input);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.calculations.map((calculation) => calculation.value)).toEqual([
			expect.closeTo(-0.1),
			expect.closeTo(-0.02),
		]);
		expect(result.rendered_report).toContain("下降 2.00 个百分点");
		expect(result.rendered_report).toContain("72.00 %");
	});

	it.each([0, 0.28, -0.5, 1])("blocks ambiguous General-format percentages %s", (value) => {
		expect(
			buildPeValuationReport(fixture([{ sheet: "Statements", cell: "D4", value }]), options([request("tax", "D4")]))
				.status,
		).toBe("blocked");
	});

	it("distinguishes percentage-point storage and ignores quoted percent format literals", () => {
		const result = buildPeValuationReport(fixture(), options([request("tax", "E4")]));
		expect(result.status).toBe("ready");
		expect(result.rendered_report).toContain("28.00 %");
		const root = fixture([{ sheet: "Statements", cell: "D4", value: 0.28, format: '0.00"%"' }]);
		expect(buildPeValuationReport(root, options([request("tax", "D4")])).status).toBe("blocked");
	});

	it("requires compatible periods for products while permitting an explicitly undated multiple", () => {
		for (const [ref, status] of [
			["D6", "ready"],
			["E6", "blocked"],
			["F6", "ready"],
		] as const) {
			const input = options([request("eps", "D5"), request("multiple", ref)]);
			input.calculations = [{ id: "price", operation: "product", left: "eps", right: "multiple" }];
			input.sections[0].fact_ids.push("price");
			const result = buildPeValuationReport(fixture(), input);
			expect(result.status, result.issues.join("\n")).toBe(status);
			if (status === "ready") expect(result.calculations[0].value).toBe(150);
		}
	});

	it("keeps unknown currencies and share scales without unsupported conversions", () => {
		for (const [ref, display] of [
			["D8", "EUR/share"],
			["D9", "shares_m"],
		]) {
			const fact = request("source", ref);
			expect(buildPeValuationReport(fixture(), options([fact])).status).toBe("ready");
			expect(buildPeValuationReport(fixture(), options([{ ...fact, display_unit: display }])).status).toBe(
				"blocked",
			);
		}
	});

	it("blocks unavailable formula values even when labels and units match", () => {
		const root = fixture([{ sheet: "Statements", cell: "D5", value: "=5" }]);
		expect(buildPeValuationReport(root, options([request("eps", "D5")])).status).toBe("blocked");
	});

	it.each([
		"收入增长20%。",
		"收入增长２０%。",
		"参考 https://example.com 认定合理。",
		"二〇二四年收入五百八十三亿欧元。",
		"有机增速百分之十一点六。",
		"毛利率扩张。",
		"税率相对稳定。",
	])("blocks unchecked narrative: %s", (analysis) => {
		const input = options([request("revenue", "B2")]);
		input.sections[0].analysis = analysis;
		const result = buildPeValuationReport(fixture(), input);
		expect(result).toMatchObject({ status: "blocked", repair_scope: "sections" });
		expect(result.rendered_report).toBeUndefined();
	});

	it("retains checked facts when a prose-only repair is resubmitted", () => {
		const root = fixture(),
			input = options([request("pe", "D6")]);
		input.sections[0].analysis = "目标 P/E 为 30 倍。";
		const blocked = buildPeValuationReport(root, input);
		expect(blocked.repair_scope).toBe("sections");
		input.sections[0].analysis = "若盈利下降，估值可能承压。";
		const ready = buildPeValuationReport(root, input);
		expect(ready.status).toBe("ready");
		expect(ready.facts).toEqual(blocked.facts);
		expect(ready.rendered_report).toContain(input.sections[0].analysis);
	});

	it("requires source support for qualitative sections and renders selected outputs only", () => {
		const target: ReportFactRequest = {
			id: "target",
			sheet_name: "Valuation",
			cell_ref: "B4",
			expected_label: "Target Price",
			expected_unit: "EUR/share",
			role: "target_price",
			valuation_method: "Agent selected method",
			context: {
				label: { sheet: "Valuation", cell: "A4", text: "Target Price" },
				unit: { sheet: "Valuation", cell: "H4", text: "EUR/share" },
			},
		};
		const input = options([target]);
		input.scope = "overview";
		const root = fixture();
		const result = buildPeValuationReport(root, input);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.rendered_report).toContain("150.00 EUR/股");
		expect(result.rendered_report).toContain("=5*30");
		expect(result.rendered_report).not.toContain("125.00");
		input.sections[0] = { title: "判断", fact_ids: [], analysis: "品牌能力影响模型假设。" };
		expect(buildPeValuationReport(root, input).status).toBe("blocked");
	});

	it("renders a concise measured sensitivity table from a matching audit run", () => {
		const target: ReportFactRequest = {
			id: "target",
			sheet_name: "Valuation",
			cell_ref: "B4",
			expected_label: "Target Price",
			expected_unit: "EUR/share",
			role: "target_price",
			context: {
				label: { sheet: "Valuation", cell: "A4", text: "Target Price" },
				unit: { sheet: "Valuation", cell: "H4", text: "EUR/share" },
			},
		};
		const root = fixture();
		const runId = "11111111-1111-4111-8111-111111111111";
		const directory = join(root, "generated", "sensitivity", runId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "result.json"),
			JSON.stringify({
				schema_version: "1.0",
				run_id: runId,
				dataset_id: "report-test",
				doc_id: "model",
				status: "completed",
				engine: { name: "libreoffice", version: "test" },
				output: { output_id: "output:test", sheet_name: "Valuation", cell_ref: "B4", baseline_value: 150 },
				shock: { method: "relative_one_at_a_time", percent: 5 },
				tested_driver_count: 1,
				active_driver_count: 1,
				sensitivity_ranking_available: true,
				ranked_drivers: [
					{
						rank: 1,
						driver_id: "driver:test",
						role: "valuation_assumption",
						label: "Target P/E",
						sheet_name: "Statements",
						cell_ref: "D6",
						baseline_input: 30,
						down_input: 28.5,
						up_input: 31.5,
						baseline_output: 150,
						down_output: 142.5,
						up_output: 157.5,
						down_output_change: -7.5,
						up_output_change: 7.5,
						down_output_change_percent: -5,
						up_output_change_percent: 5,
						max_abs_output_change: 7.5,
						max_abs_output_change_percent: 5,
						active_driver: true,
						propagation: [],
						markdown_citation: "untrusted",
					},
				],
				excluded_drivers: [],
				original_unchanged: true,
				artifacts: {
					result_json: `generated/sensitivity/${runId}/result.json`,
					summary_markdown: `generated/sensitivity/${runId}/summary.md`,
				},
				warnings: [],
				answer_contract: "test",
			}),
		);
		const input = options([target]);
		input.scope = "overview";
		input.sensitivityRunId = runId;
		const result = buildPeValuationReport(root, input);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.rendered_report).toContain("## 核心敏感性");
		expect(result.rendered_report).toContain("Target P/E");
		expect(result.rendered_report).toContain("-5.00%");
		expect(result.rendered_report).not.toContain("untrusted");
		expect(result.sensitivity).toMatchObject({ run_id: runId, ranked_driver_count: 1 });
	});
});
