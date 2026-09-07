import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPeValuationOutput, locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import { createDocumentProject } from "./document-fixture.ts";

const roots: string[] = [];

function fixture(): string {
	const root = createDocumentProject("inventory-test");
	roots.push(root);
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	database
		.prepare(`INSERT INTO documents (doc_id,dataset_id,original_filename,file_type,created_at,updated_at)
		VALUES ('model','inventory-test','synthetic-model.xlsx','xlsx','2026-01-01','2026-01-01')`)
		.run();
	for (const [index, name] of ["Equity multiples", "DCF model", "History"].entries()) {
		database
			.prepare(`INSERT INTO excel_sheets (sheet_id,dataset_id,doc_id,sheet_index,sheet_name,sheet_role,
			sheet_state,row_count,col_count,non_empty_cell_count,formula_count,formula_density)
			VALUES (?,'inventory-test','model',?,?,'worksheet','visible',30,10,20,10,0.5)`)
			.run(name, index, name);
	}
	const insert = (
		sheet: string,
		ref: string,
		value: string | number,
		label = "",
		formula?: string,
		format = "General",
		columnLabel = "",
	) => {
		const match = /^([A-Z]+)(\d+)$/u.exec(ref);
		if (!match) throw new Error("Invalid synthetic cell");
		const col = [...match[1]].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
		database
			.prepare(`INSERT INTO excel_cells (cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,
			value_type,display_value,raw_value,numeric_value,formula,cached_value,number_format,row_label,col_label,
			is_formula,formula_cache_status) VALUES (?,'inventory-test','model',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				`${sheet}!${ref}`,
				sheet,
				ref,
				Number(match[2]),
				col,
				typeof value === "number" ? "number" : "string",
				String(value),
				formula ?? String(value),
				typeof value === "number" ? value : null,
				formula ?? null,
				formula ? String(value) : null,
				format,
				label,
				columnLabel,
				formula ? 1 : 0,
				formula ? "present" : "not_applicable",
			);
		for (const [index, target] of [...(formula ?? "").matchAll(/\b([A-Z]+\d+)\b/gu)].entries()) {
			database
				.prepare(`INSERT INTO excel_formula_references (reference_id,dataset_id,doc_id,source_cell_id,
				source_sheet,source_cell_ref,reference_index,raw_reference,reference_kind,target_sheet,target_range,parse_status)
				VALUES (?,'inventory-test','model',?,?,?,?,?,'cell',?,?,'resolved')`)
				.run(`${sheet}!${ref}:${index}`, `${sheet}!${ref}`, sheet, ref, index, target[1], sheet, target[1]);
		}
	};
	insert("Equity multiples", "B1", 5, "EPS");
	insert("Equity multiples", "B2", 30, "Target P/E");
	insert("Equity multiples", "A3", "Target price");
	insert("Equity multiples", "B3", 150, "Target price", "=B1*B2");
	insert("Equity multiples", "A4", "Current price");
	insert("Equity multiples", "B4", 125, "Current price");
	insert("Equity multiples", "B5", 0.2, "Upside", "=B3/B4-1", "0.0%");
	insert("Equity multiples", "H1", 135, "", '=_xll.BDP("SYN FP Equity","PX_LAST")');
	insert("Equity multiples", "G2", "Share price");
	insert("Equity multiples", "H2", 140, "Share price");
	insert("Equity multiples", "H3", 140, "Share price", "=H2");
	insert("DCF model", "B1", 12345, "Equity value");
	insert("DCF model", "B2", 100, "Diluted shares outstanding");
	insert("DCF model", "A3", "Equity value per share");
	insert("DCF model", "B3", 120, "Equity value per share", "=ROUND(B1/B2/100,1)*100");
	insert("DCF model", "F3", "Implied TP");
	insert("DCF model", "G3", 123.45, "Implied TP", "=B1/B2");
	insert("DCF model", "D5", "Current share price");
	insert("DCF model", "D6", 130, "", '=_xll.BDP("SYN FP Equity","PX_LAST")');
	insert("DCF model", "D7", 120 / 130 - 1, "Value of equity", "=B3/D6-1", "0.00%", "Current share price");
	insert("DCF model", "E5", 20000, "Discounted EV");
	insert("DCF model", "D8", 7.5, "WACC (%)", undefined, "General", "Current share price");
	insert("DCF model", "G8", 0.05, "Range to current price", undefined, "0%");
	insert("DCF model", "D9", 120, "Shares", "=B3", "General", "Current share price");
	insert("History", "B4", 12, "Ave. share price");
	database.close();
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("valuation output inventory", () => {
	it("keeps independent methods and unrounded outputs when the ranked preview has one cell", () => {
		const result = locatePeValuationOutputs(fixture(), { docId: "model", topK: 1 });
		expect(result.candidates).toHaveLength(1);
		expect(result.output_inventory_complete).toBe(true);
		expect(result.output_groups.map((group) => group.method)).toEqual(expect.arrayContaining(["multiples", "dcf"]));
		const group = result.output_groups.find((group) => group.method === "dcf");
		expect(group?.outputs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ cell_ref: "B3", numeric_value: 120, semantic_role: "per_share_value" }),
				expect.objectContaining({ cell_ref: "G3", numeric_value: 123.45, semantic_role: "per_share_value" }),
			]),
		);
		expect(group?.relationships).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "rounding_consistent" })]),
		);
		expect(
			result.output_groups
				.flatMap((group) => group.outputs)
				.some((cell) => cell.sheet_name === "DCF model" && cell.cell_ref === "D7"),
		).toBe(false);
	});

	it("distinguishes cached quotes, model inputs and historical averages from neighbouring financial amounts", () => {
		const result = locatePeValuationOutputs(fixture(), { docId: "model" });
		const prices = result.cross_check_nodes.filter((node) => node.role === "current_price");
		expect(prices).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sheet_name: "Equity multiples",
					cell_ref: "H1",
					price_kind: "cached_external",
					price_date_status: "unknown",
				}),
				expect.objectContaining({ sheet_name: "Equity multiples", cell_ref: "H2", price_kind: "model_input" }),
				expect.objectContaining({ sheet_name: "Equity multiples", cell_ref: "B4", price_kind: "model_input" }),
				expect.objectContaining({ sheet_name: "DCF model", cell_ref: "D6", price_kind: "cached_external" }),
			]),
		);
		for (const ref of ["D7", "D8", "D9", "E5", "G8"])
			expect(prices.some((node) => node.sheet_name === "DCF model" && node.cell_ref === ref)).toBe(false);
		expect(prices.some((node) => node.sheet_name === "History")).toBe(false);
		expect(result.cross_check_nodes).toContainEqual(
			expect.objectContaining({
				sheet_name: "History",
				cell_ref: "B4",
				role: "historical_price",
				price_kind: "historical_average",
			}),
		);
		expect(
			prices.find((node) => node.sheet_name === "Equity multiples" && node.cell_ref === "B4")?.uses,
		).toContainEqual(expect.objectContaining({ cell_ref: "B5", formula: "=B3/B4-1" }));
	});

	it("refuses a percentage as a confirmed valuation amount even under an equity label", () => {
		const root = fixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		const cell = database.prepare("SELECT * FROM excel_cells WHERE sheet_name='DCF model' AND cell_ref='D7'").get();
		if (!cell) throw new Error("Missing synthetic cell");
		expect(confirmPeValuationOutput(database, "inventory-test", "model", "DCF model", cell)).toMatchObject({
			confirmed: false,
			rejection_reason: "percentage_is_not_a_valuation_amount",
		});
		database.close();
	});
});
