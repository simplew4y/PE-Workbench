import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import {
	buildPeValuationReport,
	type PeValuationReportOptions,
	type ReportFactRequest,
} from "../src/tools/valuation-report.ts";
import { createDocumentProject } from "./document-fixture.ts";

const roots: string[] = [];

function fixture(extraOutputs = 0): string {
	const root = createDocumentProject("report-test");
	roots.push(root);
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	database
		.prepare(`INSERT INTO documents (doc_id,dataset_id,original_filename,file_type,document_date,created_at,updated_at)
		VALUES ('model','report-test','synthetic-report.xlsx','xlsx','2030-01-01','2030-01-01','2030-01-01')`)
		.run();
	for (const [index, sheet] of ["Statements", "Multiples valuation", "DCF valuation"].entries())
		database
			.prepare(`INSERT INTO excel_sheets (sheet_id,dataset_id,doc_id,sheet_index,sheet_name,sheet_role,
			sheet_state,row_count,col_count,non_empty_cell_count,formula_count,formula_density)
			VALUES (?,'report-test','model',?,?,'worksheet','visible',100,10,30,10,0.3)`)
			.run(sheet, index, sheet);
	const cell = (
		sheet: string,
		ref: string,
		value: number,
		label: string,
		period: string,
		unit: string,
		formula?: string,
		format = "General",
	) => {
		const match = /^([A-Z]+)(\d+)$/u.exec(ref);
		if (!match) throw new Error("Invalid test cell");
		const column = [...match[1]].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
		database
			.prepare(`INSERT INTO excel_cells (cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,
			display_value,raw_value,numeric_value,formula,cached_value,number_format,row_label,period,unit,is_formula,formula_cache_status)
			VALUES (?,'report-test','model',?,?,?,?,'number',?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				`${sheet}!${ref}`,
				sheet,
				ref,
				Number(match[2]),
				column,
				String(value),
				formula ?? String(value),
				value,
				formula ?? null,
				formula ? String(value) : null,
				format,
				label,
				period,
				unit,
				formula ? 1 : 0,
				formula ? "present" : "not_applicable",
			);
		for (const [index, target] of [...(formula ?? "").matchAll(/\b([A-Z]+\d+)\b/gu)].entries())
			database
				.prepare(`INSERT INTO excel_formula_references (reference_id,dataset_id,doc_id,source_cell_id,
				source_sheet,source_cell_ref,reference_index,raw_reference,reference_kind,target_sheet,target_range,parse_status)
				VALUES (?,'report-test','model',?,?,?,?,?,'cell',?,?,'resolved')`)
				.run(`${sheet}!${ref}:${index}`, `${sheet}!${ref}`, sheet, ref, index, target[1], sheet, target[1]);
	};
	cell("Statements", "B1", 10000, "Revenue", "2023A", "EURm");
	cell("Statements", "C1", 9000, "Revenue", "2024A", "EURm");
	cell("Statements", "B2", 0.72, "Gross margin", "2023A", "%", undefined, "0.0%");
	cell("Statements", "C2", 0.7, "Gross margin", "2024A", "%", undefined, "0.0%");
	cell("Statements", "B3", 0.28, "Tax rate", "2026E", "%");
	cell("Statements", "B4", 28, "Tax rate", "2026E", "%");
	cell("Statements", "B5", 5, "Diluted EPS", "2026E", "EUR/share");
	cell("Statements", "B6", 30, "Target P/E", "2026E", "x");
	cell("Statements", "B7", 30, "Target P/E", "2027E", "x");
	cell("Statements", "B8", 30, "Target P/E", "", "x");
	cell("Statements", "B9", 8, "Net asset value per share", "2026E", "EUR/share");
	cell("Statements", "B10", 5, "Diluted EPS", "2026E", "per_share");
	cell("Multiples valuation", "B1", 5, "EPS", "2026E", "EUR/share");
	cell("Multiples valuation", "B2", 30, "Target P/E", "2026E", "x");
	cell("Multiples valuation", "B3", 150, "Target price", "2026E", "EUR/share", "=B1*B2");
	cell("Multiples valuation", "B4", 125, "Current price", "", "EUR/share");
	cell("Multiples valuation", "B5", 0.2, "Upside", "", "%", "=B3/B4-1", "0.0%");
	cell("Multiples valuation", "H2", 140, "Share price", "", "EUR/share");
	cell("DCF valuation", "B4", 123.45, "Implied TP", "", "EUR/share", "=123.45");
	cell("DCF valuation", "B5", 130, "Current share price", "", "EUR/share", '=_xll.BDP("SYN FP Equity","PX_LAST")');
	for (let index = 0; index < extraOutputs; index++)
		cell("Multiples valuation", `D${index + 20}`, 150 + index, "Target price", "2026E", "EUR/share", "=B1*B2");
	database.close();
	return root;
}

function request(
	id: string,
	cell_ref: string,
	expected_label: string,
	expected_period?: string,
	expected_unit?: string,
): ReportFactRequest {
	return { id, sheet_name: "Statements", cell_ref, expected_label, expected_period, expected_unit };
}

function focused(facts: ReportFactRequest[]): PeValuationReportOptions {
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

describe("deterministic valuation reports", () => {
	it.each([
		["period", { expected_period: "2024A" }],
		["unit", { expected_unit: "USDm" }],
		["label", { expected_label: "Gross profit" }],
	] as const)("blocks an incorrect %s instead of relabelling the source", (_kind, override) => {
		const fact = { ...request("revenue", "B1", "Revenue", "2023A", "EURm"), ...override };
		const result = buildPeValuationReport(fixture(), focused([fact]));
		expect(result.status).toBe("blocked");
		expect(result.rendered_report).toBeUndefined();
		expect(result.issues.join(" ")).toContain("mismatch");
	});

	it("converts million EUR to hundred-million EUR while preserving year and source citation", () => {
		const fact = { ...request("revenue", "B1", "Revenue", "2023A", "EURm"), display_unit: "EUR_100m" };
		const result = buildPeValuationReport(fixture(), focused([fact]));
		expect(result.status).toBe("ready");
		expect(result.rendered_report).toContain("100.00 亿EUR");
		expect(result.rendered_report).toContain("2023A");
		expect(result.rendered_report).toContain("#pe-source?evidence_id=source%3A");
		expect(result.rendered_report).not.toContain("2030");
	});

	it("computes falling revenue and margin with percent and percentage-point units", () => {
		const facts = [
			request("before", "B1", "Revenue", "2023A", "EURm"),
			request("after", "C1", "Revenue", "2024A", "EURm"),
			request("margin_before", "B2", "Gross margin", "2023A", "%"),
			request("margin_after", "C2", "Gross margin", "2024A", "%"),
		];
		const options = focused(facts);
		options.calculations = [
			{ id: "growth", operation: "growth", left: "before", right: "after" },
			{ id: "margin", operation: "change", left: "margin_before", right: "margin_after" },
		];
		options.sections[0].fact_ids.push("growth", "margin");
		const result = buildPeValuationReport(fixture(), options);
		expect(result.status).toBe("ready");
		expect(result.calculations.find((item) => item.id === "growth")?.value).toBeCloseTo(-0.1);
		expect(result.calculations.find((item) => item.id === "margin")?.value).toBeCloseTo(-0.02);
		expect(result.rendered_report).toContain("下降 10.00 %");
		expect(result.rendered_report).toContain("下降 2.00 个百分点");
		expect(result.rendered_report).toContain("72.00 %");
	});

	it.each([0, 0.28, -0.5, 1])("blocks ambiguous General-format percentage storage %s", (value) => {
		const root = fixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database
			.prepare(
				"UPDATE excel_cells SET numeric_value=?,raw_value=?,display_value=? WHERE sheet_name='Statements' AND cell_ref='B3'",
			)
			.run(value, String(value), String(value));
		database.close();
		const result = buildPeValuationReport(root, focused([request("tax", "B3", "Tax rate", "2026E", "%")]));
		expect(result.status).toBe("blocked");
		expect(result.rendered_report).toBeUndefined();
	});

	it("accepts explicit percentage points without pretending they are fractions", () => {
		const result = buildPeValuationReport(fixture(), focused([request("tax", "B4", "Tax rate", "2026E", "%")]));
		expect(result.status).toBe("ready");
		expect(result.rendered_report).toContain("28.00 %");
		expect(result.rendered_report).not.toContain("2,800");
	});

	it("uses literal percentage text but never percent literals inside a formula as storage evidence", () => {
		const root = fixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("UPDATE excel_cells SET raw_value='28%' WHERE sheet_name='Statements' AND cell_ref='B3'");
		const textResult = buildPeValuationReport(root, focused([request("tax", "B3", "Tax rate", "2026E", "%")]));
		expect(textResult.status).toBe("ready");
		expect(textResult.rendered_report).toContain("28.00 %");
		database.exec(
			"UPDATE excel_cells SET raw_value='=28%*100',formula='=28%*100',is_formula=1,cached_value='28',formula_cache_status='present' WHERE sheet_name='Statements' AND cell_ref='B4'",
		);
		const formulaResult = buildPeValuationReport(root, focused([request("tax", "B4", "Tax rate", "2026E", "%")]));
		expect(formulaResult.status).toBe("ready");
		expect(formulaResult.rendered_report).toContain("28.00 %");
		database.exec(
			`UPDATE excel_cells SET raw_value='0.28',number_format='0.00"%"' WHERE sheet_name='Statements' AND cell_ref='B3'`,
		);
		database.close();
		expect(buildPeValuationReport(root, focused([request("tax", "B3", "Tax rate", "2026E", "%")])).status).toBe(
			"blocked",
		);
	});

	it("does not assume two prices with unspecified currencies are comparable", () => {
		const root = fixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(
			"UPDATE excel_cells SET unit='per_share' WHERE sheet_name='Multiples valuation' AND cell_ref IN ('B3','B4')",
		);
		database.close();
		const options = focused([
			{ id: "target", sheet_name: "Multiples valuation", cell_ref: "B3", expected_label: "Target price" },
			{ id: "price", sheet_name: "Multiples valuation", cell_ref: "B4", expected_label: "Current price" },
		]);
		options.calculations = [{ id: "upside", operation: "upside", left: "target", right: "price" }];
		options.sections[0].fact_ids.push("upside");
		expect(buildPeValuationReport(root, options).status).toBe("blocked");
	});

	it.each(["B7", "B9"])("rejects mixed-year or non-EPS products using %s", (ref) => {
		const mismatchPeriod = ref === "B7";
		const facts = [
			request(
				"eps",
				mismatchPeriod ? "B5" : "B9",
				mismatchPeriod ? "Diluted EPS" : "Net asset value per share",
				"2026E",
				"EUR/share",
			),
			request("pe", mismatchPeriod ? "B7" : "B6", "Target P/E", mismatchPeriod ? "2027E" : "2026E", "x"),
		];
		const options = focused(facts);
		options.calculations = [{ id: "price", operation: "product", left: "eps", right: "pe" }];
		options.sections[0].fact_ids.push("price");
		expect(buildPeValuationReport(fixture(), options).status).toBe("blocked");
	});

	it.each(["B6", "B8"])("allows matching-period or undated fixed valuation multiples %s", (ref) => {
		const facts = [
			request("eps", "B5", "Diluted EPS", "2026E", "EUR/share"),
			request("pe", ref, "Target P/E", ref === "B6" ? "2026E" : "", "x"),
		];
		const options = focused(facts);
		options.calculations = [{ id: "price", operation: "product", left: "eps", right: "pe" }];
		options.sections[0].fact_ids.push("price");
		const result = buildPeValuationReport(fixture(), options);
		expect(result.status).toBe("ready");
		expect(result.calculations[0]?.value).toBe(150);
	});

	it("keeps an unspecified per-share currency unspecified", () => {
		const result = buildPeValuationReport(
			fixture(),
			focused([request("eps", "B10", "Diluted EPS", "2026E", "per_share")]),
		);
		expect(result.status).toBe("ready");
		expect(result.rendered_report).not.toContain("EUR");
		expect(result.rendered_report).not.toContain("未确认");
		expect(result.facts[0]?.cell.unit).toBe("per_share");
		const incompatible = { ...request("eps", "B10", "Diluted EPS", "2026E", "per_share"), display_unit: "EUR/share" };
		expect(buildPeValuationReport(fixture(), focused([incompatible])).status).toBe("blocked");
	});

	it("covers both methods and every price input even when the ranked top-K omits DCF", () => {
		const root = fixture(30);
		const inventory = locatePeValuationOutputs(root, { docId: "model", topK: 25 });
		expect(inventory.candidate_count).toBeGreaterThan(25);
		expect(inventory.candidates.some((candidate) => candidate.sheet_name === "DCF valuation")).toBe(false);
		const options = focused([]);
		options.scope = "overview";
		const result = buildPeValuationReport(root, options);
		expect(result.status).toBe("ready");
		for (const text of [
			"DCF valuation",
			"Multiples valuation",
			"123.45",
			"125.00",
			"130.00",
			"140.00",
			"外部函数保存值",
		])
			expect(result.rendered_report).toContain(text);
		expect(result.rendered_report).toContain("Implied TP");
		expect(result.rendered_report).toContain("125.00 EUR/股");
		expect(result.rendered_report).not.toMatch(/未确认|未标期间|日期参考|文件保存时间/u);
	});

	it("does not accept a numeric field when its formula cache is unavailable", () => {
		const root = fixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database
			.prepare(
				"UPDATE excel_cells SET is_formula=1,formula='=5',cached_value=NULL,formula_cache_status='missing' WHERE sheet_name='Statements' AND cell_ref='B5'",
			)
			.run();
		database.close();
		const result = buildPeValuationReport(root, focused([request("eps", "B5", "Diluted EPS", "2026E", "EUR/share")]));
		expect(result.status).toBe("blocked");
		expect(result.issues.join(" ")).toContain("cache");
	});

	it.each([
		"收入增长20%。",
		"收入增长２０%。",
		"参考 https://example.com 认定合理。",
		"二〇二四年收入五百八十三亿欧元。",
		"有机增速百分之十一点六。",
		"毛利率扩张。",
		"税率相对稳定。",
	])("blocks unsupported narrative content: %s", (analysis) => {
		const options = focused([request("revenue", "B1", "Revenue", "2023A", "EURm")]);
		options.sections[0].analysis = analysis;
		const result = buildPeValuationReport(fixture(), options);
		expect(result.status).toBe("blocked");
		expect(result.rendered_report).toBeUndefined();
	});

	it("does not disguise unverified trends as section headings", () => {
		const options = focused([request("revenue", "B1", "Revenue", "2023A", "EURm")]);
		options.sections[0].title = "毛利率扩张";
		expect(buildPeValuationReport(fixture(), options).status).toBe("blocked");
	});

	it("renders the reported section titles with supported qualitative drivers and conditional risks", () => {
		const options = focused([request("revenue", "B1", "Revenue", "2023A", "EURm")]);
		options.scope = "overview";
		options.sections = [
			{ title: "估值方法框架", fact_ids: ["revenue"], analysis: "经营假设影响模型的估值依据。" },
			{ title: "核心驱动因素", fact_ids: ["revenue"], analysis: "若收入下降，利润可能下滑。" },
			{
				title: "盈利预测与估值敏感性",
				fact_ids: ["revenue"],
				analysis: "品牌定价能力的提升是需要检验的假设。",
			},
			{ title: "模型核心风险点", fact_ids: ["revenue"], analysis: "利润下降可能影响目标价。" },
		];
		const result = buildPeValuationReport(fixture(), options);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.section_issues).toEqual([]);
		for (const section of options.sections) expect(result.rendered_report).toContain(section.analysis);
	});

	it("identifies prose-only repairs and becomes ready after resubmitting the same checked facts", () => {
		const root = fixture();
		const options = focused([request("pe", "B6", "Target P/E", "2026E", "x")]);
		options.sections[0] = { title: "估值方法框架", fact_ids: ["pe"], analysis: "目标 P/E 为 30 倍。" };
		const blocked = buildPeValuationReport(root, options);
		expect(blocked.status).toBe("blocked");
		expect(blocked.repair_scope).toBe("sections");
		expect(blocked.section_issues).toEqual([
			expect.objectContaining({
				section_index: 0,
				field: "analysis",
				code: "numeric_claim",
				excerpt: "目标 P/E 为 30 倍。",
			}),
		]);
		expect(blocked.rendered_report).toBeUndefined();
		options.sections[0].analysis = "目标倍数影响模型的估值依据。";
		const ready = buildPeValuationReport(root, options);
		expect(ready.status).toBe("ready");
		expect(ready.facts).toEqual(blocked.facts);
		expect(ready.repair_scope).toBeUndefined();
		expect(ready.rendered_report).toContain("30.00 倍");
		expect(ready.rendered_report).toContain("#pe-source?evidence_id=source%3A");
	});

	it.each(["source", "fact_id"])("does not mark %s errors as prose-only repairs", (kind) => {
		const fact = request("pe", "B6", "Target P/E", "2026E", kind === "source" ? "EURm" : "x");
		const options = focused([fact]);
		options.sections[0].analysis = "目标 P/E 为 30 倍。";
		if (kind === "fact_id") options.sections[0].fact_ids.push("nonexistent");
		const result = buildPeValuationReport(fixture(), options);
		expect(result.status).toBe("blocked");
		expect(result.section_issues).toHaveLength(1);
		expect(result.repair_scope).toBeUndefined();
	});

	it("preserves qualitative reasoning with evidence and ordinary Chinese words", () => {
		const options = focused([request("revenue", "B1", "Revenue", "2023A", "EURm")]);
		options.sections[0].analysis = "一方面，品牌定价能力影响模型假设；另一方面，需进一步核实竞争格局。";
		expect(buildPeValuationReport(fixture(), options).status).toBe("ready");
		options.sections[0].fact_ids = [];
		expect(buildPeValuationReport(fixture(), options).status).toBe("blocked");
	});

	it("retains raw share counts without an unknown-scale notice or unsupported conversion", () => {
		const root = fixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(
			"UPDATE excel_cells SET numeric_value=104.93,row_label='Weighted Average Shares (Fully Diluted)',unit='share_count_unspecified_scale' WHERE sheet_name='Statements' AND cell_ref='B10'",
		);
		database.close();
		const fact = request(
			"shares",
			"B10",
			"Weighted Average Shares (Fully Diluted)",
			"2026E",
			"share_count_unspecified_scale",
		);
		const result = buildPeValuationReport(root, focused([fact]));
		expect(result.status).toBe("ready");
		expect(result.rendered_report).toContain("104.93（模型填写值）");
		expect(result.rendered_report).not.toMatch(/未确认|百万股|股数原表单位/u);
		expect(result.facts[0]?.cell.unit).toBe("share_count_unspecified_scale");
		expect(buildPeValuationReport(root, focused([{ ...fact, display_unit: "shares_m" }])).status).toBe("blocked");
	});

	it("omits missing-information commentary while retaining supported qualitative business risks", () => {
		const options = focused([request("revenue", "B1", "Revenue", "2023A", "EURm")]);
		options.sections[0].analysis =
			"估值日期尚未确认。模型未提供独立敏感性表。品牌定价能力影响盈利假设。竞争加剧可能影响利润。";
		const result = buildPeValuationReport(fixture(), options);
		expect(result.status, result.issues.join("\n")).toBe("ready");
		expect(result.rendered_report).not.toMatch(/未确认|未提供|敏感性表/u);
		expect(result.rendered_report).toContain("品牌定价能力影响盈利假设。");
		expect(result.rendered_report).toContain("竞争加剧可能影响利润。");
	});
});
