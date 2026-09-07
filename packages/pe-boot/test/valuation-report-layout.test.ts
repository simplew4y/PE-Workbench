import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseSourceId } from "../src/source.ts";
import { buildPeValuationReport } from "../src/tools/valuation-report.ts";
import { compactReportCitations } from "../src/tools/valuation-report-layout.ts";
import { createDocumentProject } from "./document-fixture.ts";

const roots: string[] = [];

function fixture(): string {
	const root = createDocumentProject("layout");
	roots.push(root);
	const db = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	db.exec(`INSERT INTO documents (doc_id,dataset_id,original_filename,file_type,created_at,updated_at)
		VALUES ('model','layout','long_filename_valuation_model.xlsx','xlsx','2030-01-01','2030-01-01');
		INSERT INTO excel_sheets (sheet_id,dataset_id,doc_id,sheet_index,sheet_name,sheet_role,sheet_state,row_count,col_count,non_empty_cell_count,formula_count,formula_density)
		VALUES ('sheet','layout','model',0,'Valuation','worksheet','visible',40,12,25,5,0.2);`);
	const insert = db.prepare(`INSERT INTO excel_cells
		(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,display_value,raw_value,
		numeric_value,row_label,period,unit,formula,cached_value,is_formula,formula_cache_status)
		VALUES (?,'layout','model','Valuation',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
	function cell(ref: string, value: string | number, label = "", period = "", formula?: string) {
		const match = /^([A-Z]+)(\d+)$/u.exec(ref);
		if (!match) throw new Error("Invalid fixture cell");
		const column = [...match[1]].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
		insert.run(
			ref,
			ref,
			Number(match[2]),
			column,
			typeof value === "number" ? "number" : "string",
			String(value),
			formula ?? String(value),
			typeof value === "number" ? value : null,
			label,
			period,
			typeof value === "number" ? "per_share" : null,
			formula ?? null,
			formula ? String(value) : null,
			formula ? 1 : 0,
			formula ? "present" : "not_applicable",
		);
	}
	cell("B4", "PE");
	cell("B9", "Fair value per share");
	cell("B10", "EV / EBIT");
	cell("B21", "Fair value per share");
	cell("B23", "Weighted target price");
	for (const [column, period, pe, ev] of [
		["C", "2018", 51.3, 52.5],
		["I", "2024", 71.1, 87.7],
		["J", "2025E", 32.1, 36],
		["K", "2026E", 50.6, 57.2],
		["L", "2027E", 57.6, 66.4],
	] as const) {
		cell(`${column}3`, period);
		cell(`${column}9`, pe, "Fair value per share", period);
		cell(`${column}21`, ev, "Fair value per share", period);
		cell(`${column}23`, (pe + ev) / 2, "Weighted target price", period, `=ROUND((${column}9+${column}21)/2,2)`);
	}
	db.close();
	return root;
}

function report(root: string): string {
	const result = buildPeValuationReport(root, {
		docId: "model",
		scope: "overview",
		facts: [],
		calculations: [],
		sections: [],
	});
	expect(result.status, result.issues.join("\n")).toBe("ready");
	return result.rendered_report ?? "";
}

function update(root: string, sql: string): void {
	const db = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	try {
		db.exec(sql);
	} finally {
		db.close();
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readable valuation overview", () => {
	it("aligns forecast years and methods on one sheet and explains the actual weighting formula", () => {
		const text = report(fixture());
		const [main, history] = text.split("## 历史期间对照");
		expect(main).toContain("| 估值方法／结果 | 2025E | 2026E | 2027E |");
		expect(main).toMatch(/\| 综合目标价 \| 34\.05 .*\| 53\.90 .*\| 62\.00 /u);
		expect(main).toMatch(/\| 市盈率法（P\/E）.*\| 32\.10 .*\| 50\.60 .*\| 57\.60 /u);
		expect(main).toMatch(/\| 企业价值／息税前利润法（EV\/EBIT）.*\| 36\.00 .*\| 57\.20 .*\| 66\.40 /u);
		expect(main).toContain("(32.10 + 36.00) ÷ 2 = 34.05");
		expect(main).toContain("各占 50%");
		expect(main).not.toMatch(/2018|2024|unspecified|ambiguous|long_filename/u);
		expect(history).toContain("| 估值方法／结果 | 2018 | 2024 |");
		expect(history).toContain("51.30");
		expect(history).toContain("87.70");
		expect(main.match(/币种未确认/gu)).toHaveLength(1);
		const citations = [...text.matchAll(/\[来源\]\((#pe-source\?[^)]+)\)/gu)];
		const cells = new Set(
			citations.map((match) => {
				const source = parseSourceId(new URLSearchParams(match[1].split("?")[1]).get("evidence_id") ?? "");
				return source?.location.kind === "excel" ? source.location.range : undefined;
			}),
		);
		for (const column of ["C", "I", "J", "K", "L"])
			for (const row of [9, 21, 23]) expect(cells.has(`${column}${row}`)).toBe(true);
	});

	it("retains separate columns for duplicate years and unknown periods", () => {
		const root = fixture();
		update(
			root,
			"UPDATE excel_cells SET period='2026E' WHERE col_index=12; UPDATE excel_cells SET period=NULL WHERE col_index=10",
		);
		const main = report(root).split("## 历史期间对照")[0];
		expect(main).toContain("期间待核对（J列） | 2026E（K列） | 2026E（L列）");
		expect(main).toContain("32.10");
		expect(main).toContain("57.60");
	});

	it("does not invent equal weights when only values happen to average", () => {
		const root = fixture();
		update(
			root,
			"UPDATE excel_cells SET formula=NULL,is_formula=0,formula_cache_status='not_applicable' WHERE row_index=23",
		);
		const text = report(root);
		expect(text).not.toContain("各占 50%");
		expect(text).toContain("不能仅凭结果数值推定");
	});

	it("does not state a weighting calculation with missing input caches", () => {
		const root = fixture();
		update(root, "UPDATE excel_cells SET formula='=1',is_formula=1,formula_cache_status='missing' WHERE row_index=9");
		const text = report(root);
		expect(text).toContain("缓存不可用");
		expect(text).not.toContain("各占 50%");
	});

	it("does not infer currency or reuse an ambiguous period from the locator", () => {
		const root = fixture();
		update(
			root,
			`UPDATE excel_cells SET metadata_json='{"period_context":{"status":"ambiguous","method":"conflicting_headers","sources":[]}}' WHERE col_index=10`,
		);
		const main = report(root).split("## 历史期间对照")[0];
		expect(main).toContain("期间待核对（J列）");
		expect(main).not.toContain("EUR");
		expect(main).not.toContain("2025E");
	});

	it("does not borrow a method header from an unrelated horizontal block", () => {
		const root = fixture();
		update(root, "UPDATE excel_cells SET col_index=6,cell_ref='F10' WHERE cell_ref='B10'");
		const text = report(root);
		expect(text).not.toContain("企业价值／息税前利润法（EV/EBIT）");
	});

	it("shortens only the display label and preserves the exact source URL", () => {
		const citation = "[a\\[b\\] long file.xlsx Valuation!K23](#pe-source?evidence_id=source%3Ax%2520y&v=2)";
		expect(compactReportCitations(citation)).toBe("[来源](#pe-source?evidence_id=source%3Ax%2520y&v=2)");
		expect(compactReportCitations("[ordinary](https://example.com/a)")).toBe("[ordinary](https://example.com/a)");
	});
});
