import type * as ChildProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { registerPeDocuments } from "../src/documents.ts";
import { readResearchInput } from "../src/research/pi-engine.ts";
import { enqueueResearchJob } from "../src/research/watch.ts";
import type { SqlRow } from "../src/tools/database.ts";
import { excelCellDetail } from "../src/tools/excel-cells.ts";
import { peWorkbookInspectTool } from "../src/tools/workbook-inspect.ts";
import { peWorkbookSearchTool } from "../src/tools/workbook-search.ts";
import { readWorkbookDocument, readWorkbookFile } from "../src/workbook-reader.ts";
import { createDocumentProject } from "./document-fixture.ts";
import { workbookSourceFixture, writeWorkbookFixture } from "./workbook-source-fixture.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof ChildProcess>();
	return { ...real, spawnSync: vi.fn(real.spawnSync) };
});
const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("passes published navigation to Python rather than rebuilding structure for a new range", async () => {
	const { root, datasetId, docId } = await workbookSourceFixture();
	roots.push(root);
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	try {
		vi.mocked(spawnSync).mockClear();
		const result = readWorkbookDocument(database, datasetId, docId, {
			action: "read",
			sheet: "Valuation",
			range: "A1:B3",
		});
		expect(result).not.toHaveProperty("_navigation");
		const options = vi.mocked(spawnSync).mock.calls[0][2] as { input: string };
		const pointer = database.prepare("SELECT cache_path FROM document_cache WHERE doc_id=?").get(docId)!;
		const navigationPath = join(root, dirname(String(pointer.cache_path)), "navigation.json");
		expect(JSON.parse(options.input)._navigation).toEqual(
			JSON.parse(readFileSync(navigationPath, "utf8")).navigation,
		);
		expect((result.cells as SqlRow[]).map(excelCellDetail)[0].style).toBeDefined();
	} finally {
		database.close();
	}
}, 20_000);

it("prepares unattached file navigation once and reuses it across different requests without leaking it", () => {
	const path = new URL("./fixtures/excel-parity.xlsx", import.meta.url).pathname;
	const first = readWorkbookFile(path, { action: "inspect", limit: 17 });
	expect(first).not.toHaveProperty("_navigation");
	vi.mocked(spawnSync).mockClear();
	const result = readWorkbookFile(path, { action: "read", sheet: "Valuation", range: "A1:B2", limit: 7 });
	expect(result).not.toHaveProperty("_navigation");
	const options = vi.mocked(spawnSync).mock.calls[0][2] as { input: string };
	const payload = JSON.parse(options.input);
	expect(payload._navigation.sheet_count).toBe(first.sheet_count);
});

it("preserves style, comment and conditional-format markers in project cell adapters", () => {
	const style = { font_color: { type: "rgb", value: "FF0000FF", tint: 0 }, bold: true };
	const comment = { author: "Analyst", text: "Forecast assumption" };
	const matched_fields = ["comment"];
	const row = {
		doc_id: "style-test",
		file_type: "xlsx",
		original_filename: "Styles.xlsx",
		sheet_name: "Inputs",
		cell_ref: "A1",
		style,
		comment,
		matched_fields,
		metadata_json: JSON.stringify({ conditional_formatting: true }),
	};
	expect(excelCellDetail(row as unknown as SqlRow)).toMatchObject({
		style,
		comment,
		matched_fields,
		conditional_formatting: true,
	});
});

it("publishes comment navigation and search indexes shared by project and research readers", async () => {
	const datasetId = "comment-test";
	const root = createDocumentProject(datasetId);
	roots.push(root);
	const document = registerPeDocuments(root, datasetId, [
		{
			name: "Comments.xlsx",
			bytes: readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url)),
		},
	]).documents[0];
	const docId = String(document.doc_id);
	const comment = { author: "Analyst", text: "Margin assumption needs checking" };
	writeWorkbookFixture(root, docId, [
		{ sheet: "Model", cell: "A1", value: "Margin", comment },
		{ sheet: "Model", cell: "D80", value: null, comment },
	]);
	vi.mocked(spawnSync).mockClear();
	const ctx = { cwd: root } as Parameters<typeof peWorkbookInspectTool.execute>[4];
	const inspected = await peWorkbookInspectTool.execute(
		"inspect",
		{
			doc_id: docId,
			sheet: "Model",
			section: "comment_cells",
		},
		undefined,
		undefined,
		ctx,
	);
	const reads = vi
		.mocked(spawnSync)
		.mock.calls.filter((call) => (call[1] as string[]).some((arg) => arg.endsWith("/workbook_reader.py")));
	expect(reads).toHaveLength(1);
	expect(JSON.parse((reads[0][2] as { input: string }).input)._navigation).toBeDefined();
	expect(inspected.details).toMatchObject({
		workbooks: [{ comment_cells: ["A1", "D80"], matching_item_count: 2, sheet: { comment_cells_count: 2 } }],
	});
	const searched = await peWorkbookSearchTool.execute(
		"search",
		{
			doc_id: docId,
			query: "Margin",
		},
		undefined,
		undefined,
		ctx,
	);
	expect(searched.details).toMatchObject({
		cells: [
			{ cell_ref: "A1", comment, matched_fields: ["value", "comment"] },
			{ cell_ref: "D80", comment, matched_fields: ["comment"], display_value: "" },
		],
	});
	const job = enqueueResearchJob(root, datasetId, "Check comments", [docId], "evidence", null);
	const research = readResearchInput(root, datasetId, job.input, { docId, action: "search", query: "Margin" });
	expect(research).toMatchObject({
		cells: [
			{ cell_ref: "A1", comment, matched_fields: ["value", "comment"] },
			{ cell_ref: "D80", comment, matched_fields: ["comment"] },
		],
	});
}, 20_000);
