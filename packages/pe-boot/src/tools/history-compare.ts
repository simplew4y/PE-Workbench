import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { comparePeMemoVersions, getPeMemoVersion, listPeMemoHistory } from "./memo-storage.ts";

export const PE_HISTORY_COMPARE_PROMPT_SNIPPET =
	"List, inspect, or compare registered Memo versions in the current PE project";

export const peHistoryCompareTool = defineTool({
	name: "pe_history_compare",
	label: "PE Memo History",
	description:
		"Use list to resolve Memo series and exact version IDs, get to inspect a prior immutable version, and compare to classify section changes as added, changed, unchanged, or not_mentioned. It only reads Memo history for the dataset bound to the current workspace.",
	promptSnippet: PE_HISTORY_COMPARE_PROMPT_SNIPPET,
	parameters: Type.Object({
		operation: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("compare")]),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		topic: Type.Optional(Type.String({ description: "Optional topic filter for list.", maxLength: 500 })),
		series_id: Type.Optional(Type.String({ description: "Optional Memo series ID filter for list." })),
		limit: Type.Optional(
			Type.Integer({
				description: "Maximum versions returned by list. Defaults to 20; maximum 100.",
				minimum: 1,
				maximum: 100,
			}),
		),
		memo_version_id: Type.Optional(Type.String({ description: "Exact mv_... version ID required by get." })),
		from_version_id: Type.Optional(Type.String({ description: "Earlier mv_... version ID required by compare." })),
		to_version_id: Type.Optional(Type.String({ description: "Later mv_... version ID required by compare." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		signal?.throwIfAborted();
		let result: unknown;
		if (params.operation === "list") {
			result = listPeMemoHistory(ctx.cwd, {
				datasetId: params.dataset_id,
				topic: params.topic,
				seriesId: params.series_id,
				limit: params.limit,
			});
		} else if (params.operation === "get") {
			if (!params.memo_version_id?.trim()) throw new Error("memo_version_id is required when operation='get'");
			result = getPeMemoVersion(ctx.cwd, params.memo_version_id, params.dataset_id);
		} else {
			if (!params.from_version_id?.trim() || !params.to_version_id?.trim()) {
				throw new Error("from_version_id and to_version_id are required when operation='compare'");
			}
			result = comparePeMemoVersions(ctx.cwd, params.from_version_id, params.to_version_id, params.dataset_id);
		}
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
