import { relative } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { sourceFilename, textValue } from "./database.ts";

export const peDocumentOpenTool = defineTool({
	name: "pe_document_open",
	label: "PE Document Open",
	description:
		"Open one uploaded Excel workbook by filename or doc_id. Prepares its structured cache and returns a readable text path for native read or grep.",
	promptSnippet: "Prepare one selected Excel workbook for native read/grep with stable source citations",
	parameters: Type.Object({
		path: Type.Optional(
			Type.String({ description: "Uploaded filename or path under raw/. Select with native ls/find first." }),
		),
		doc_id: Type.Optional(Type.String({ description: "Exact document ID; use instead of path." })),
		dataset_id: Type.Optional(Type.String({ description: "Must match the current project when provided." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const prepared = await preparePeDocument(
			ctx.cwd,
			{ path: params.path, docId: params.doc_id, datasetId: params.dataset_id },
			signal,
		);
		const result = {
			dataset_id: prepared.datasetId,
			doc_id: textValue(prepared.document, "doc_id"),
			filename: sourceFilename(prepared.document),
			readable_path: relative(ctx.cwd, prepared.readablePath).replaceAll("\\", "/"),
			warnings: prepared.warnings,
			next_step:
				"Use native read or grep (or bash with rg) on readable_path. Copy exact source citation links beside material claims. Use pe_source_detail to verify a location; use pe_excel_range for workbook cell values and formulas.",
		};
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
