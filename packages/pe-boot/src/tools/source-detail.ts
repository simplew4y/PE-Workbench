import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolvePeEvidenceSource } from "../documents.ts";

export const peSourceDetailTool = defineTool({
	name: "pe_source_detail",
	label: "PE Source Detail",
	description:
		"Verify a citation against its immutable original file version. Returns bounded PDF page text, Excel cell context, text lines, or an Office paragraph/slide. The web preview uses this same reader.",
	promptSnippet: "Resolve a file-version citation to its original page, cells, lines, or block",
	parameters: Type.Object({
		evidence_id: Type.String({
			description: "Exact source: ID from a document view or financial tool.",
			minLength: 8,
			maxLength: 2048,
		}),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const { payload } = await resolvePeEvidenceSource(ctx.cwd, params.evidence_id, signal);
		return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
	},
});
