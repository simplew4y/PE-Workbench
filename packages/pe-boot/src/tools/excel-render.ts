import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readWorkbookDocument } from "../workbook-reader.ts";
import { openPeDataset } from "./database.ts";

export const peExcelRenderTool = defineTool({
	name: "pe_excel_render",
	label: "PE Excel Range Image",
	description:
		"Render a local source range with LibreOffice when text and coordinates do not explain its layout. Requires soffice and pdftoppm. Use source read results for numeric evidence; rendering a copy does not validate recalculation.",
	promptSnippet: "View a bounded workbook range as an image to resolve layout ambiguity",
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		sheet: Type.String({ minLength: 1 }),
		range: Type.String({ minLength: 1 }),
		dataset_id: Type.Optional(Type.String()),
	}),
	async execute(_id, params, signal, _update, ctx) {
		signal?.throwIfAborted();
		const { database, datasetId } = openPeDataset(ctx.cwd, params.dataset_id);
		try {
			const { image, ...result } = readWorkbookDocument(database, datasetId, params.doc_id, {
				action: "render",
				sheet: params.sheet,
				range: params.range,
			});
			const rendered = image as { type: "image"; mimeType: string; data: string };
			return { content: [{ type: "text", text: JSON.stringify(result) }, rendered], details: result };
		} finally {
			database.close();
		}
	},
});
