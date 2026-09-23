import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookDocument } from "../workbook-reader.ts";
import { formatWorkbookCellsText } from "../workbook-text.ts";
import { openPeDataset, type SqlRow, sourceFilename } from "./database.ts";
import { excelCellDetail } from "./excel-cells.ts";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 300;

export const peWorkbookSearchTool = defineTool({
	name: "pe_workbook_search",
	label: "PE Workbook Search",
	description:
		"Search literal cell text and comment text throughout an immutable workbook, including hidden sheets and comments on blank cells. Returns compact lines (cell, value, formula, notes, evidence_id) under a text budget; matched_fields in notes distinguishes value and comment matches. Read neighboring ranges to interpret matches. Continue with next_offset; a limited result is not an exhaustive search.",
	promptSnippet: "Find source text and exact cell coordinates in a workbook before reading ranges or tracing formulas",
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		query: Type.String({ minLength: 1, maxLength: 500 }),
		sheet: Type.Optional(Type.String({ minLength: 1 })),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_LIMIT,
				description: `Defaults to ${DEFAULT_LIMIT}; maximum ${MAX_LIMIT}.`,
			}),
		),
		dataset_id: Type.Optional(Type.String()),
		include_evidence_ids: Type.Optional(
			Type.Boolean({ description: "Emit a source: evidence_id per matched cell. Defaults to true." }),
		),
	}),
	async execute(_id, params, signal, _update, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const { database, datasetId } = openPeDataset(ctx.cwd, params.dataset_id);
		try {
			const document = database
				.prepare(
					"SELECT doc_id, original_filename, source_relpath, version_no FROM documents WHERE dataset_id=? AND doc_id=?",
				)
				.get(datasetId, params.doc_id) as SqlRow | undefined;
			const result = readWorkbookDocument(database, datasetId, params.doc_id, {
				action: "search",
				query: params.query,
				sheet: params.sheet,
				offset: params.offset,
				limit: params.limit ?? DEFAULT_LIMIT,
			});
			result.cells = (result.cells as SqlRow[]).map(excelCellDetail);
			result.query = params.query;
			if (document)
				result.document = {
					doc_id: params.doc_id,
					filename: sourceFilename(document),
					version_no: document.version_no,
				};
			const rendered = formatWorkbookCellsText(result, {
				includeEvidenceIds: params.include_evidence_ids !== false,
			});
			return {
				content: [{ type: "text", text: rendered.text }],
				details: { ...result, model_text: rendered.summary },
			};
		} finally {
			database.close();
		}
	},
});
