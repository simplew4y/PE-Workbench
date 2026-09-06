import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { savePeResearchNote } from "./research-note-storage.ts";

export const PE_RESEARCH_NOTE_SAVE_PROMPT_SNIPPET =
	"Save a one-off, evidence-linked Research Note HTML artifact under generated/research-notes";

export const peResearchNoteSaveTool = defineTool({
	name: "pe_research_note_save",
	label: "PE Research Note Save",
	description:
		"Save one complete, self-contained Research Note HTML document exactly as provided, register its metadata and evidence references in the current project's collection database, and return non-blocking warnings for evidence IDs that cannot be resolved. The tool chooses the fixed generated/research-notes path; it does not revise or overwrite prior notes.",
	promptSnippet: PE_RESEARCH_NOTE_SAVE_PROMPT_SNIPPET,
	parameters: Type.Object({
		title: Type.String({ description: "Research Note title.", minLength: 1, maxLength: 200 }),
		summary: Type.String({ description: "Concise Research Note summary.", minLength: 1, maxLength: 2_000 }),
		presentation_mode: Type.Union(
			[Type.Literal("text"), Type.Literal("metrics"), Type.Literal("table"), Type.Literal("chart")],
			{ description: "The note's primary presentation form." },
		),
		content_html: Type.String({
			description: "Complete, self-contained Simplified Chinese HTML document to save without modification.",
			minLength: 1,
			maxLength: 50_000,
		}),
		evidence_ids: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
			description:
				"Exact page: PDF or source: Excel evidence IDs used by the note. Legacy cell: IDs are accepted. May be empty.",
			maxItems: 100,
		}),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = await savePeResearchNote(
			ctx.cwd,
			{
				title: params.title,
				summary: params.summary,
				presentationMode: params.presentation_mode,
				contentHtml: params.content_html,
				evidenceIds: params.evidence_ids,
				datasetId: params.dataset_id,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
