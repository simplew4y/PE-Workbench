import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolvePeEvidenceReference } from "../evidence.ts";
import { createResearchDraft, getResearchFramework } from "../research/framework.ts";
import { FrameworkContentSchema } from "../research/model.ts";
import { sourceId } from "../source.ts";
import { openPeDataset } from "./database.ts";

export const peFrameworkTool = defineTool({
	name: "pe_investment_framework",
	label: "Investment framework",
	description:
		"Read the project's confirmed investment framework or propose a complete new draft from this conversation. Read before revising; preserve stable item IDs. This tool NEVER confirms or publishes. After proposing, explain the framework in your reply; the user confirms with the button below that reply. Changes must be another proposal. Use exact source: or page: evidence IDs returned by PE tools; page IDs are converted to versioned source locations before saving; label unverified hypotheses as user and record coverage gaps.",
	promptSnippet:
		"Discuss, generate and revise investment frameworks in chat using pe_investment_framework. Always save a proposal before presenting a framework for confirmation. Only the user's 确定投资框架 button publishes it; never claim it is confirmed without reading the current state.",
	parameters: Type.Object({
		operation: Type.Union([Type.Literal("read"), Type.Literal("propose")]),
		content: Type.Optional(FrameworkContentSchema),
		docIds: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: 100,
				description: "Exact prepared document version IDs supporting this proposal.",
			}),
		),
		expectedVersionId: Type.Optional(
			Type.Union([Type.String(), Type.Null()], {
				description: "Confirmed version ID returned by read, or null when none exists.",
			}),
		),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		signal?.throwIfAborted();
		if (
			params.operation === "propose" &&
			(!params.content || !params.docIds || params.expectedVersionId === undefined)
		)
			throw new Error("A proposal requires content, docIds and expectedVersionId from read");
		const connection = openPeDataset(ctx.cwd);
		const { datasetId, workspaceRoot } = connection;
		connection.database.close();
		const result =
			params.operation === "read"
				? {
						kind: "pe_framework_state",
						datasetId,
						framework: getResearchFramework(workspaceRoot, datasetId),
					}
				: {
						kind: "pe_framework_draft",
						datasetId,
						draft: createResearchDraft(
							workspaceRoot,
							datasetId,
							{
								...params.content!,
								items: params.content!.items.map((item) => ({
									...item,
									evidenceIds: [
										...new Set(
											item.evidenceIds.map((id) =>
												id.startsWith("page:") ? sourceId(resolvePeEvidenceReference(ctx.cwd, id)) : id,
											),
										),
									],
								})),
							},
							params.docIds!,
							params.expectedVersionId!,
						),
					};
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
