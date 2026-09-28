import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PeDriverSensitivityResult } from "../src/tools/driver-sensitivity.ts";
import {
	buildPeValuationReport,
	type PeValuationReportOptions,
	type ReportFactRequest,
} from "../src/tools/valuation-report.ts";
import { createDocumentProject } from "./document-fixture.ts";
import { type WorkbookFixtureCell, writeWorkbookFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
const datasetId = "report-units-test";
const runId = "22222222-2222-4222-8222-222222222222";
const driverId = "driver:growth";
const mixedHeader = "CNY million; shares million; price CNY/share";
const rows: Record<number, [string, string]> = {
	2: ["Revenue", "CNYm"],
	3: ["Diluted EPS", "CNY/share"],
	4: ["Shares", "shares_m"],
	5: ["Target P/E", "x"],
	6: ["Target Price", "CNY/share"],
	7: ["Growth input", "%"],
	8: ["Opening revenue", "CNYm"],
	9: ["Cost input", "CNYm"],
	10: ["Tax rate", "%"],
};

function fixture(changes: WorkbookFixtureCell[] = []): string {
	const root = createDocumentProject(datasetId);
	roots.push(root);
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	database
		.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES('model',?,'units.xlsx','xlsx','completed','now','now')",
		)
		.run(datasetId);
	database
		.prepare(
			"INSERT INTO excel_sheets(sheet_id,dataset_id,doc_id,sheet_index,sheet_name,sheet_role,sheet_state,used_range,row_count,col_count,non_empty_cell_count,formula_count,formula_density) VALUES('model-sheet',?,'model',1,'Model','worksheet','visible','A1:H10',10,8,40,8,0.2)",
		)
		.run(datasetId);
	database.close();
	const cells: WorkbookFixtureCell[] = [
		{ sheet: "Model", cell: "A1", value: mixedHeader },
		{ sheet: "Model", cell: "B1", value: "2026E" },
		{ sheet: "Model", cell: "C1", value: "2027E" },
		{ sheet: "Model", cell: "B2", value: "=B8*(1+B7)", cached: 110 },
		{ sheet: "Model", cell: "C2", value: "=B2*(1+B7)", cached: 121 },
		{ sheet: "Model", cell: "B3", value: "=(B2-B9)*(1-B10)/B4", cached: 3.75 },
		{ sheet: "Model", cell: "C3", value: "=(C2-C9)*(1-B10)/B4", cached: 4.125 },
		{ sheet: "Model", cell: "B4", value: 10 },
		{ sheet: "Model", cell: "B5", value: 20 },
		{ sheet: "Model", cell: "B6", value: "=B3*B5", cached: 75 },
		{ sheet: "Model", cell: "C6", value: "=C3*B5", cached: 82.5 },
		{ sheet: "Model", cell: "B7", value: 0.1, format: "0.0%" },
		{ sheet: "Model", cell: "B8", value: 100 },
		{ sheet: "Model", cell: "B9", value: 60 },
		{ sheet: "Model", cell: "C9", value: 66 },
		{ sheet: "Model", cell: "B10", value: 0.25, format: "0.0%" },
	];
	for (const [row, [label, unit]] of Object.entries(rows))
		cells.push({ sheet: "Model", cell: `A${row}`, value: label }, { sheet: "Model", cell: `H${row}`, value: unit });
	writeWorkbookFixture(root, "model", [
		...cells.filter((cell) => !changes.some((change) => change.sheet === cell.sheet && change.cell === cell.cell)),
		...changes,
	]);
	return root;
}

function fact(id: string, cell: string, sharedHeader = false): ReportFactRequest {
	const row = Number(cell.slice(1));
	const [label, unit] = rows[row];
	return {
		id,
		sheet_name: "Model",
		cell_ref: cell,
		expected_label: label,
		expected_period: cell.startsWith("C") ? "2027E" : "2026E",
		expected_unit: unit,
		context: {
			label: { sheet: "Model", cell: `A${row}`, text: label },
			period: { sheet: "Model", cell: `${cell[0]}1`, text: cell.startsWith("C") ? "2027E" : "2026E" },
			unit: { sheet: "Model", cell: sharedHeader ? "A1" : `H${row}`, text: sharedHeader ? mixedHeader : unit },
		},
	};
}

function options(facts: ReportFactRequest[]): PeValuationReportOptions {
	return {
		docId: "model",
		datasetId,
		scope: "focused",
		facts,
		calculations: [],
		sections: [{ title: "核验结果", fact_ids: facts.map((item) => item.id) }],
	};
}

function sensitivityRun(): PeDriverSensitivityResult {
	const propagation = [
		["B7", 0.1, 0.09, 0.11],
		["B2", 110, 109, 111],
		["C2", 121, 118.81, 123.21],
		["B3", 3.75, 3.675, 3.825],
		["C3", 4.125, 3.96075, 4.29075],
		["B6", 75, 73.5, 76.5],
		["C6", 82.5, 79.215, 85.815],
	] as const;
	return {
		schema_version: "1.0",
		run_id: runId,
		dataset_id: datasetId,
		doc_id: "model",
		status: "completed",
		engine: { name: "libreoffice", version: "saved run fixture" },
		output: { output_id: "output:2027", sheet_name: "Model", cell_ref: "C6", baseline_value: 82.5 },
		shock: { method: "relative_one_at_a_time", percent: 10 },
		tested_driver_count: 1,
		active_driver_count: 1,
		sensitivity_ranking_available: true,
		ranked_drivers: [
			{
				rank: 1,
				driver_id: driverId,
				role: "operating_assumption",
				label: "Growth input",
				sheet_name: "Model",
				cell_ref: "B7",
				baseline_input: 0.1,
				down_input: 0.09,
				up_input: 0.11,
				baseline_output: 82.5,
				down_output: 79.215,
				up_output: 85.815,
				down_output_change: -3.285,
				up_output_change: 3.315,
				max_abs_output_change: 3.315,
				active_driver: true,
				propagation: propagation.map(([cell, baseline, down, up]) => ({
					sheet_name: "Model",
					cell_ref: cell,
					label: rows[Number(cell.slice(1))][0],
					is_formula: cell !== "B7",
					baseline_value: baseline,
					down_value: down,
					up_value: up,
				})),
				markdown_citation: "untrusted saved-run citation",
			},
		],
		excluded_drivers: [],
		original_unchanged: true,
		artifacts: {
			result_json: `generated/sensitivity/${runId}/result.json`,
			summary_markdown: `generated/sensitivity/${runId}/summary.md`,
		},
		warnings: [],
		answer_contract: "Fixture for validating saved propagation; no model or recalculation is executed by this test.",
	};
}

function saveRun(root: string, run = sensitivityRun()): void {
	const directory = join(root, "generated", "sensitivity", runId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "result.json"), JSON.stringify(run));
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source-derived report units and focused numeric conditions", () => {
	it.each([
		["EURm", "EUR", "EUR_100m", 1.1, "1.10 亿EUR"],
		["CNYm", "CNYbn", "CNY_100m", 1.1, "1.10 亿CNY"],
	] as const)(
		"asserts the source %s scale before converting only the display unit",
		(source, wrong, display, value, text) => {
			const root = fixture([{ sheet: "Model", cell: "H2", value: source }]);
			const request = fact("revenue", "B2");
			request.context!.unit.text = source;
			request.expected_unit = source;
			request.display_unit = display;
			const result = buildPeValuationReport(root, options([request]));
			expect(result.status, result.issues.join("\n")).toBe("ready");
			expect(result.facts[0]).toMatchObject({
				value: 110,
				cell: { numeric_value: 110 },
				quantity: { scale: 1e6 },
				display_quantity: { scale: 1e8 },
			});
			expect((result.facts[0].value * result.facts[0].quantity.scale) / result.facts[0].display_quantity.scale).toBe(
				value,
			);
			expect(result.rendered_report).toContain(text);
			expect(result.rendered_report).toContain("#pe-source?evidence_id=source%3A");
			const blocked = buildPeValuationReport(root, options([{ ...request, expected_unit: wrong }]));
			expect(blocked.status).toBe("blocked");
			expect(blocked.issues.join(" ")).toMatch(/unit.*(?:conflict|scale)/iu);
			expect(blocked.rendered_report).toBeUndefined();
		},
	);

	it("converts raw million-denominated amounts without treating their header as Excel display scaling", () => {
		const root = fixture([
			{ sheet: "Model", cell: "B2", value: 418399 },
			{ sheet: "Model", cell: "H2", value: "人民币百万元" },
		]);
		const request = fact("revenue", "B2");
		request.context!.unit.text = "人民币百万元";
		request.display_unit = "CNY_100m";
		const result = buildPeValuationReport(root, options([request]));
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.rendered_report).toContain("4,183.99 亿CNY");
	});

	it("does not use a format with trailing scaling commas as the storage unit", () => {
		const format = '"CNY"#,##0.00,,"m"';
		const root = fixture([{ sheet: "Model", cell: "B2", value: 418399e6, format }]);
		const request = fact("revenue", "B2");
		request.context!.unit = { sheet: "Model", cell: "B2", text: format, field: "number_format" };
		const result = buildPeValuationReport(root, options([request]));
		expect(result.status).toBe("blocked");
		expect(result.issues.join(" ")).toContain("display scaling");
		expect(result.rendered_report).toBeUndefined();
	});

	it("resolves amount, per-share and share-count units from one mixed header using original metric labels", () => {
		const result = buildPeValuationReport(
			fixture(),
			options([fact("revenue", "B2", true), fact("eps", "B3", true), fact("shares", "B4", true)]),
		);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.facts.map(({ quantity, value }) => [quantity.dimension, quantity.scale, value])).toEqual([
			["CNY", 1e6, 110],
			["CNY/share", 1, 3.75],
			["shares", 1e6, 10],
		]);
		expect(result.rendered_report).toContain("3.75 CNY/股");
		expect(result.rendered_report).toContain("10.00 百万股");
	});

	it.each([
		["B2", "Diluted EPS", "CNY/share"],
		["B3", "Revenue", "CNYm"],
		["B4", "Revenue", "CNYm"],
	] as const)("does not let expected labels change the mixed-header unit for %s", (cell, label, unit) => {
		const request = { ...fact("source", cell, true), expected_label: label, expected_unit: unit };
		const result = buildPeValuationReport(fixture(), options([request]));
		expect(result.status).toBe("blocked");
		expect(result.issues.join(" ")).toContain("Source unit conflicts");
	});

	it.each([0, 0.9, 1.1])("keeps source units and provenance in EPS × P/E conditions with factor %s", (factor) => {
		const input = options([{ ...fact("eps", "B3", true), factor }, fact("pe", "B5")]);
		input.calculations = [{ id: "price", operation: "product", left: "eps", right: "pe" }];
		input.sections[0].fact_ids.push("price");
		const result = buildPeValuationReport(fixture(), input);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.facts[0]).toMatchObject({
			factor,
			value: 3.75 * factor,
			cell: { numeric_value: 3.75 },
			quantity: { dimension: "CNY/share", scale: 1 },
		});
		expect(result.calculations[0].value).toBeCloseTo(75 * factor);
		expect(result.calculations[0].text).toContain("CNY/股");
		expect(result.rendered_report).toContain("补充条件：原值×");
		expect(result.rendered_report).not.toContain("隔离重算");
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"blocks non-finite supplemental factor %s",
		(factor) => {
			const result = buildPeValuationReport(fixture(), options([{ ...fact("eps", "B3"), factor }]));
			expect(result.status).toBe("blocked");
			expect(result.issues.join(" ")).toContain("factor must be finite");
		},
	);

	it("rejects mixing an otherwise valid scenario and supplemental factor", () => {
		const root = fixture();
		saveRun(root);
		const result = buildPeValuationReport(
			root,
			options([
				{
					...fact("eps", "B3"),
					factor: 0.9,
					scenario: { run_id: runId, driver_id: driverId, direction: "up" },
				},
			]),
		);
		expect(result.status).toBe("blocked");
		expect(result.issues.join(" ")).toContain("never both");
	});

	it.each(["down", "up"] as const)(
		"reads the selected propagation cell and preserves its original unit for %s scenarios",
		(direction) => {
			const root = fixture();
			saveRun(root);
			const scenario = { run_id: runId, driver_id: driverId, direction };
			const input = options([
				{ ...fact("revenue", "C2", true), scenario },
				{ ...fact("eps", "C3", true), scenario },
			]);
			const result = buildPeValuationReport(root, input);
			expect(result.status, result.issues.join("\n")).toBe("ready");
			expect(result.facts.map(({ value }) => value)).toEqual(
				direction === "up" ? [123.21, 4.29075] : [118.81, 3.96075],
			);
			expect(result.facts.map(({ cell }) => cell.numeric_value)).toEqual([121, 4.125]);
			expect(result.facts.map(({ quantity }) => [quantity.dimension, quantity.scale])).toEqual([
				["CNY", 1e6],
				["CNY/share", 1],
			]);
			expect(result.rendered_report).toContain("百万CNY");
			expect(result.rendered_report).toContain("CNY/股");
			expect(result.rendered_report).toContain("隔离重算");
			expect(result.rendered_report).toContain("=B2*(1+B7)");
			expect(result.rendered_report).toContain("=(C2-C9)*(1-B10)/B4");
			expect(result.rendered_report).not.toContain("untrusted saved-run citation");
		},
	);

	it("accepts negative upstream baselines using the recalculation engine's absolute-magnitude shocks", () => {
		const values = [
			["B7", -0.1, -0.11, -0.09],
			["B2", 90, 89, 91],
			["C2", 81, 79.21, 82.81],
			["B3", 2.25, 2.175, 2.325],
			["C3", 1.125, 0.99075, 1.26075],
			["B6", 45, 43.5, 46.5],
			["C6", 22.5, 19.815, 25.215],
		] as const;
		const formulas: Record<string, string> = {
			B2: "=B8*(1+B7)",
			C2: "=B2*(1+B7)",
			B3: "=(B2-B9)*(1-B10)/B4",
			C3: "=(C2-C9)*(1-B10)/B4",
			B6: "=B3*B5",
			C6: "=C3*B5",
		};
		const root = fixture(
			values.map(([cell, baseline]) => ({
				sheet: "Model",
				cell,
				value: formulas[cell] ?? baseline,
				...(formulas[cell] ? { cached: baseline } : { format: "0.0%" }),
			})),
		);
		const run = sensitivityRun();
		run.output.baseline_value = 22.5;
		const driver = run.ranked_drivers[0];
		Object.assign(driver, {
			baseline_input: -0.1,
			down_input: -0.11,
			up_input: -0.09,
			baseline_output: 22.5,
			down_output: 19.815,
			up_output: 25.215,
			down_output_change: -2.685,
			up_output_change: 2.715,
			max_abs_output_change: 2.715,
		});
		for (const [cell, baseline, down, up] of values) {
			const node = driver.propagation.find((item) => item.cell_ref === cell)!;
			Object.assign(node, { baseline_value: baseline, down_value: down, up_value: up });
		}
		saveRun(root, run);
		const result = buildPeValuationReport(
			root,
			options([
				{
					...fact("eps", "C3", true),
					scenario: { run_id: runId, driver_id: driverId, direction: "down" },
				},
			]),
		);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.facts[0]).toMatchObject({ value: 0.99075, cell: { numeric_value: 1.125 } });
	});

	it("allows same-cell scenario changes with units while keeping growth and other-cell comparisons period-bound", () => {
		const root = fixture([{ sheet: "Model", cell: "B1", value: "2027E" }]);
		saveRun(root);
		const scenario = { run_id: runId, driver_id: driverId, direction: "up" as const };
		const input = options([
			fact("revenue_base", "C2", true),
			{ ...fact("revenue_up", "C2", true), scenario },
			fact("eps_base", "C3", true),
			{ ...fact("eps_up", "C3", true), scenario },
		]);
		input.calculations = [
			{ id: "revenue_change", operation: "change", left: "revenue_base", right: "revenue_up" },
			{ id: "eps_change", operation: "change", left: "eps_base", right: "eps_up" },
		];
		input.sections[0].fact_ids.push("revenue_change", "eps_change");
		const result = buildPeValuationReport(root, input);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.calculations[0].value).toBeCloseTo(2210000);
		expect(result.calculations[1].value).toBeCloseTo(0.16575);
		expect(result.calculations[0].text).toContain("2.21 百万CNY");
		expect(result.calculations[1].text).toContain("0.16575 CNY/股");
		expect(result.calculations[0].text).toContain("隔离重算");
		expect(result.facts.map(({ cell }) => cell.numeric_value)).toEqual([121, 121, 4.125, 4.125]);

		const growth = buildPeValuationReport(root, {
			...input,
			calculations: input.calculations.map((calculation) => ({ ...calculation, operation: "growth" })),
		});
		expect(growth.facts).toHaveLength(4);
		expect(growth.status).toBe("blocked");
		expect(growth.calculations).toHaveLength(0);
		expect(growth.issues.join(" ")).toContain("ordered periods");

		const otherCell = fact("other_revenue", "B2", true);
		otherCell.expected_period = "2027E";
		otherCell.context!.period!.text = "2027E";
		const differentCells = options([otherCell, { ...fact("revenue_up", "C2", true), scenario }]);
		differentCells.calculations = [
			{ id: "invalid_change", operation: "change", left: "other_revenue", right: "revenue_up" },
		];
		differentCells.sections[0].fact_ids.push("invalid_change");
		const blocked = buildPeValuationReport(root, differentCells);
		expect(blocked.facts).toHaveLength(2);
		expect(blocked.status).toBe("blocked");
		expect(blocked.calculations).toHaveLength(0);
		expect(blocked.issues.join(" ")).toContain("same source cell");
	});

	it("preserves qualitative unknowns and unrecalculated-path gaps in a focused answer", () => {
		const input = options([fact("eps", "B3", true)]);
		const analysis = "其他模型路径尚未重算。 外部资料未知。";
		input.sections[0].analysis = analysis;
		const result = buildPeValuationReport(fixture(), input);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.rendered_report).toContain(analysis);
	});

	it("retains the selected per-share output unit when sensitivity falls back to absolute changes", () => {
		const root = fixture();
		const run = sensitivityRun();
		delete run.ranked_drivers[0].max_abs_output_change_percent;
		saveRun(root, run);
		const input = options([{ ...fact("target", "C6", true), role: "target_price" }]);
		input.sensitivityRunId = runId;
		const result = buildPeValuationReport(root, input);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.rendered_report).toContain("## 核心敏感性");
		expect(result.rendered_report).toContain("3.315 CNY/股");
	});

	it.each([
		"document",
		"dataset",
		"driver",
		"cell",
		"baseline",
		"input_baseline",
		"output_baseline",
		"direction_value",
	] as const)("blocks a saved scenario with a mismatching or missing %s", (mismatch) => {
		const root = fixture();
		const run = sensitivityRun();
		const driver = run.ranked_drivers[0];
		const node = driver.propagation.find((item) => item.cell_ref === "C3")!;
		if (mismatch === "document") run.doc_id = "another-document";
		if (mismatch === "dataset") run.dataset_id = "another-dataset";
		if (mismatch === "driver") driver.driver_id = "driver:other";
		if (mismatch === "cell") node.cell_ref = "D3";
		if (mismatch === "baseline") node.baseline_value = 4.2;
		if (mismatch === "input_baseline") driver.baseline_input = 0.12;
		if (mismatch === "output_baseline") run.output.baseline_value = 90;
		if (mismatch === "direction_value") Reflect.deleteProperty(node, "up_value");
		saveRun(root, run);
		const result = buildPeValuationReport(
			root,
			options([
				{
					...fact("eps", "C3", true),
					scenario: { run_id: runId, driver_id: driverId, direction: "up" },
				},
			]),
		);
		expect(result.status, mismatch).toBe("blocked");
		expect(result.issues.join(" ")).toContain("Scenario");
		expect(result.rendered_report).toBeUndefined();
	});
});
