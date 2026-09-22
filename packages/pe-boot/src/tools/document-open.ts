import { relative } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { numberValue, sourceFilename, textValue } from "./database.ts";

export const peDocumentOpenTool = defineTool({
	name: "pe_document_open",
	label: "PE Document Open",
	description:
		"Open one uploaded Excel, text, CSV, DOCX, or PPTX file by filename or immutable doc_id. Returns Excel navigation or a disposable text view for other formats with versioned source citations. Rebuilds missing caches. For Excel use pe_workbook_search and pe_excel_range; readable_path contains navigation only. For other formats use read/grep. Use pe_pdf_search and pe_pdf_read for PDFs.",
	promptSnippet:
		"Prepare one selected workbook or text/Office document for native read/grep, with citations pinned to its original version and location",
	parameters: Type.Object({
		path: Type.Optional(
			Type.String({ description: "Uploaded filename or path under raw/. Select with native ls/find first." }),
		),
		doc_id: Type.Optional(
			Type.String({ description: "Exact document version ID; use instead of path to reopen that version." }),
		),
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
			version_no: numberValue(prepared.document, "version_no"),
			filename: sourceFilename(prepared.document),
			readable_path: relative(ctx.cwd, prepared.readablePath).replaceAll("\\", "/"),
			warnings: prepared.warnings,
			next_step: ["xlsx", "xlsm"].includes(String(prepared.document.file_type))
				? "readable_path contains navigation only. Search with pe_workbook_search, then use pe_excel_range and pe_formula_trace on the original workbook. Continue paginated results; infer periods and units from cited source context."
				: "Use native read or grep on readable_path. Copy exact source citation links beside material claims. Use pe_source_detail to verify a location.",
		};
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
