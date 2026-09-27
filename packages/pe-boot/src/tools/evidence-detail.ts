import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolvePeEvidenceSource } from "../evidence.ts";

export const PE_SOURCE_DETAIL_PROMPT_SNIPPET =
	"Resolve one exact PDF page: or Excel source: citation and return its verified page text or cell grid with formulas and formats";

export const peEvidenceDetailTool = defineTool({
	name: "pe_source_detail",
	label: "PE Source Detail",
	description:
		"Verify one page: or source: evidence reference. Returns PDF page text or an Excel grid with formulas, cached values, number formats, and source metadata.",
	promptSnippet: PE_SOURCE_DETAIL_PROMPT_SNIPPET,
	parameters: Type.Object({
		evidence_id: Type.String({
			description: "Exact page:<page_id> or source:<encoded-location> returned by a PE tool.",
			minLength: 6,
		}),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = await resolvePeEvidenceSource(ctx.cwd, params.evidence_id, signal);
		return {
			content: [{ type: "text", text: JSON.stringify(result.payload) }],
			details: result.payload,
		};
	},
});
