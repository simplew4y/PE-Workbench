import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookDocument } from "../workbook-reader.ts";
import { openPeDataset, type SqlRow } from "./database.ts";
import { excelCellDetail } from "./excel-cells.ts";

export const peWorkbookSearchTool = defineTool({
	name: "pe_workbook_search",
	label: "PE Workbook Search",
	description:
		"Search literal cell text and comment text throughout an immutable workbook, including hidden sheets and comments on blank cells. matched_fields distinguishes value and comment matches; comments are not cell values. Read neighboring ranges to interpret matches. Continue with next_offset; a limited result is not an exhaustive search.",
	promptSnippet: "Find source text and exact cell coordinates in a workbook before reading ranges or tracing formulas",
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		query: Type.String({ minLength: 1, maxLength: 500 }),
		sheet: Type.Optional(Type.String({ minLength: 1 })),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		dataset_id: Type.Optional(Type.String()),
	}),
	async execute(_id, params, signal, _update, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const { database, datasetId } = openPeDataset(ctx.cwd, params.dataset_id);
		try {
			const result = readWorkbookDocument(database, datasetId, params.doc_id, {
				action: "search",
				query: params.query,
				sheet: params.sheet,
				offset: params.offset,
				limit: params.limit ?? 30,
			});
			result.cells = (result.cells as SqlRow[]).map(excelCellDetail);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		} finally {
			database.close();
		}
	},
});
