import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolvePeEvidenceReference } from "../evidence.ts";
import { createResearchDraftAsync, getResearchFramework } from "../research/framework.ts";
import {
	FrameworkContentSchema,
	type FrameworkDraft,
	type FrameworkState,
	mapFrameworkEvidenceIds,
} from "../research/model.ts";
import { renderInvestmentFrameworkMarkdown } from "../research/report.ts";
import { sourceId } from "../source.ts";
import { openPeDataset } from "./database.ts";

export const peFrameworkTool = defineTool({
	name: "pe_investment_framework",
	label: "Investment framework",
	description:
		"Read the project's framework or propose a complete schemaVersion=2 seven-section document. Load investment-framework-builder for generation/revision. Read before revising; preserve stable IDs and all seven sections. This tool NEVER confirms or publishes. The saved complete draft is displayed directly to the user; after a successful proposal, reply briefly that it is ready for the user's confirmation. Do not reproduce the document or call propose again for the same content. Use exact source: or page: evidence IDs from PE tools; all page references are normalized before saving. Preserve unknowns as gaps; origin=user only for hypotheses actually supplied by the user.",
	promptSnippet:
		"An investment framework is the complete seven-section document. Load investment-framework-builder, read current state, then propose all seven sections. The saved document appears directly in the conversation; reply only with a brief confirmation prompt. Only the user's 确定投资框架 button publishes the saved draft; never claim confirmation before reading state.",
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
	async execute(_id, params, signal, onUpdate, ctx) {
		signal?.throwIfAborted();
		if (
			params.operation === "propose" &&
			(!params.content || !params.docIds || params.expectedVersionId === undefined)
		)
			throw new Error("A proposal requires content, docIds and expectedVersionId from read");
		const connection = openPeDataset(ctx.cwd);
		const { datasetId, workspaceRoot } = connection;
		connection.database.close();
		let result:
			| { kind: "pe_framework_state"; datasetId: string; framework: FrameworkState; draft?: never }
			| { kind: "pe_framework_draft"; datasetId: string; draft: FrameworkDraft; framework?: never };
		try {
			result =
				params.operation === "read"
					? {
							kind: "pe_framework_state",
							datasetId,
							framework: getResearchFramework(workspaceRoot, datasetId),
						}
					: {
							kind: "pe_framework_draft",
							datasetId,
							draft: await createResearchDraftAsync(
								workspaceRoot,
								datasetId,
								mapFrameworkEvidenceIds(params.content!, (id) =>
									id.startsWith("page:") ? sourceId(resolvePeEvidenceReference(ctx.cwd, id)) : id,
								),
								params.docIds!,
								params.expectedVersionId!,
								{
									signal,
									onProgress: (progress) => {
										const status =
											progress.phase === "retry"
												? `读取超时，正在重试同一批引用（第 ${progress.attempt} 次）`
												: progress.phase === "validated" && progress.completed === progress.total
													? "引用核验完成，正在保存草案"
													: "正在核验引用";
										onUpdate?.({
											content: [{ type: "text", text: `${status} ${progress.completed}/${progress.total}` }],
											details: { kind: "pe_framework_progress", datasetId, ...progress },
										});
									},
								},
							),
						};
		} catch (error) {
			signal?.throwIfAborted();
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ETIMEDOUT" ||
				!("attempts" in error) ||
				error.attempts !== 2
			)
				throw error;
			const message = "工作簿引用读取连续两次超时，本次草案未保存。请稍后重试；无需重新生成投资框架。";
			const details = {
				kind: "pe_framework_error",
				datasetId,
				error: message,
				code: "ETIMEDOUT",
				attempts: 2,
				retryExhausted: true,
				technicalError: error.message,
				instruction:
					"Stop here. The same submitted framework was already attempted twice (including one retry). Do not regenerate its JSON or call propose again in this run. The user can retry later; no new draft was saved or confirmed.",
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details, terminate: true };
		}
		const instruction =
			"The complete saved document is already displayed to the user. Reply briefly that the draft is ready for the 确定投资框架 button. Do not reproduce the document, propose it again, or claim it is confirmed.";
		const details = result.draft
			? {
					...result,
					rendered_report: renderInvestmentFrameworkMarkdown(result.draft.content),
					instruction,
				}
			: result;
		const modelResult = result.draft
			? { kind: result.kind, datasetId, draftId: result.draft.id, status: result.draft.status, instruction }
			: details;
		return { content: [{ type: "text", text: JSON.stringify(modelResult) }], details };
	},
});
