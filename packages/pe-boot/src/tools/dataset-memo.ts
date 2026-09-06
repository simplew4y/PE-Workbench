import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { savePeMemo } from "./memo-storage.ts";

export const PE_DATASET_MEMO_PROMPT_SNIPPET =
	"Create or revise an evidence-gated, versioned Memo under generated/memo from structured claims";

export const peDatasetMemoTool = defineTool({
	name: "pe_dataset_memo",
	label: "PE Dataset Memo",
	description:
		"Create a new Memo series or an immutable revision from structured claims. The tool validates each evidence ID, applies Citation Gate, writes Markdown, safe HTML, and PDF under generated/memo, and registers series/version lineage in the current project's collection database. Use create for a new canonical topic and revise with an exact memo version ID for an intentional update.",
	promptSnippet: PE_DATASET_MEMO_PROMPT_SNIPPET,
	parameters: Type.Object({
		operation: Type.Union([Type.Literal("create"), Type.Literal("revise")], {
			description:
				"Semantic intent. revise creates a new immutable version; create never overwrites an existing topic.",
		}),
		topic: Type.String({
			description: "Stable canonical Memo topic. Keep it unchanged across revisions.",
			minLength: 1,
			maxLength: 500,
		}),
		title: Type.Optional(
			Type.String({ description: "Client-facing Memo title. Defaults to topic.", maxLength: 500 }),
		),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		revision_of: Type.Optional(
			Type.String({
				description: "Exact mv_... Memo version ID. Required for revise and forbidden for create.",
			}),
		),
		as_of_date: Type.Optional(
			Type.String({ description: "Evidence cut-off date in YYYY-MM-DD format. Defaults to today." }),
		),
		instructions: Type.Optional(
			Type.String({
				description: "Internal user requirements retained as provenance; not rendered as an artifact section.",
			}),
		),
		conversation_context: Type.Optional(
			Type.String({
				description: "Concise internal context retained as provenance; not rendered as an artifact section.",
			}),
		),
		key_questions: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
				description: "Research questions covered by the Memo. Stored as provenance.",
				maxItems: 30,
			}),
		),
		memo_claims: Type.Array(
			Type.Object({
				section: Type.String({ description: "Client-facing section title.", minLength: 1, maxLength: 200 }),
				text: Type.String({ description: "One claim without citation markup.", minLength: 1, maxLength: 4_000 }),
				status: Type.Union([Type.Literal("supported"), Type.Literal("not_covered"), Type.Literal("needs_review")]),
				evidence_ids: Type.Array(Type.String({ minLength: 3, maxLength: 2048 }), {
					description:
						"Exact source: IDs returned by the document reader. Leave empty for not_covered or needs_review.",
					maxItems: 20,
				}),
			}),
			{
				description:
					"Complete desired Memo state, one structured claim per item. Revisions are full snapshots, not patches.",
				minItems: 1,
				maxItems: 200,
			},
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = await savePeMemo(
			ctx.cwd,
			{
				operation: params.operation,
				topic: params.topic,
				title: params.title,
				datasetId: params.dataset_id,
				revisionOf: params.revision_of,
				asOfDate: params.as_of_date,
				instructions: params.instructions,
				conversationContext: params.conversation_context,
				keyQuestions: params.key_questions,
				claims: params.memo_claims.map((claim) => ({
					section: claim.section,
					text: claim.text,
					status: claim.status,
					evidenceIds: claim.evidence_ids,
				})),
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
