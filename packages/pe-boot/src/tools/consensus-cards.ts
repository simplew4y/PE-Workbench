import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listPeConsensusCards } from "../consensus.ts";

const CARD_TYPES = ["consensus", "divergence", "single_view"] as const;
export const PE_CONSENSUS_CARDS_PROMPT_SNIPPET =
	"Read project-sample consensus/divergence, coverage and staleness; include_sources returns verified page citations and quotes";
export const peConsensusCardsTool = defineTool({
	name: "pe_consensus_cards",
	label: "PE Consensus Cards",
	description:
		"List the consensus/divergence cards computed at ingest for the current PE project. One card covers one analysis question and period: institution coverage, median and range, the optimistic and cautious sides with their reasons, recent upward/downward revisions, the company's own guidance when present, and model-written lines for root cause and evidence to verify. Pass include_sources=true to get every underlying claim with quotes and #pe-source links. These are project-sample views, not market consensus or verified forecasts. Respect status/coverage/stale; never describe stale cards as latest. Numbers are computed from grounded claims, not proof of future outcomes.",
	promptSnippet: PE_CONSENSUS_CARDS_PROMPT_SNIPPET,
	parameters: Type.Object({
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		card_types: Type.Optional(
			Type.Array(Type.Union(CARD_TYPES.map((value) => Type.Literal(value))), {
				description: "Filter by card type. Defaults to all types.",
			}),
		),
		item_key: Type.Optional(
			Type.String({ description: "Only the card(s) for one checklist item key, e.g. revenue." }),
		),
		limit: Type.Optional(
			Type.Integer({
				description: "Maximum cards returned, ordered by priority. Defaults to 20; maximum 100.",
				minimum: 1,
				maximum: 100,
			}),
		),
		include_sources: Type.Optional(
			Type.Boolean({
				description: "Include every underlying claim with quotes and source links. Defaults to false.",
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		signal?.throwIfAborted();
		const result = listPeConsensusCards(ctx.cwd, {
			datasetId: params.dataset_id,
			cardTypes: params.card_types,
			itemKey: params.item_key,
			limit: params.limit,
			includeSources: params.include_sources,
		});
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
