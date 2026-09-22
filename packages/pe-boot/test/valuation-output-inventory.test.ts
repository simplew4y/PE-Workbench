import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import { createDocumentProject } from "./document-fixture.ts";
import { writeWorkbookFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
function fixture(): string {
	const root = createDocumentProject("inventory-test");
	roots.push(root);
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	database
		.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES('model','inventory-test','Model.xlsx','xlsx','completed','now','now')",
		)
		.run();
	database.close();
	writeWorkbookFixture(root, "model", [
		{ sheet: "Valuation", cell: "A1", value: "Target price" },
		{ sheet: "Valuation", cell: "B1", value: "=5*30", cached: 150 },
		{ sheet: "Valuation", cell: "A2", value: "Current price" },
		{ sheet: "Valuation", cell: "B2", value: 125 },
		{ sheet: "估值", cell: "A1", value: "目标价" },
		{ sheet: "估值", cell: "B1", value: 120 },
	]);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("valuation source search", () => {
	it("requires a literal query and returns paged original locations without selecting outputs", () => {
		const root = fixture();
		expect(() => locatePeValuationOutputs(root, { docId: "model" })).toThrow("query is required");
		const first = locatePeValuationOutputs(root, { docId: "model", query: "price", topK: 1 });
		expect(first).toMatchObject({ status: "search_results", search_complete: false, next_offset: 1 });
		expect(first.matches.map((cell) => cell.cell_ref)).toEqual(["A1"]);
		expect(first).not.toHaveProperty("selected_output");
		const second = locatePeValuationOutputs(root, {
			docId: "model",
			query: "price",
			topK: 1,
			offset: first.next_offset,
		});
		expect(second.matches.map((cell) => cell.cell_ref)).toEqual(["A2"]);
		expect(second.search_complete).toBe(true);
		expect(second.next_offset).toBeUndefined();
	});

	it("supports the workbook's language and does not treat an empty English search as missing outputs", () => {
		const root = fixture();
		const found = locatePeValuationOutputs(root, { docId: "model", query: "目标", sheetName: "估值" });
		expect(found.matches).toEqual([
			expect.objectContaining({ sheet_name: "估值", cell_ref: "A1", raw_value: "目标价" }),
		]);
		const empty = locatePeValuationOutputs(root, { docId: "model", query: "target price", sheetName: "估值" });
		expect(empty).toMatchObject({ status: "search_results", matches: [], search_complete: true });
		expect(empty).not.toHaveProperty("selected_candidate_id");
	});

	it("leaves combinations of search terms to the caller instead of pretending semantic search", () => {
		const result = locatePeValuationOutputs(fixture(), { docId: "model", query: "target price current price" });
		expect(result.matches).toEqual([]);
		expect(result.answer_contract).toContain("Change query");
	});
});
