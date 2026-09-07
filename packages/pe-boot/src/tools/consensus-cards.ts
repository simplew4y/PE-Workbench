import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evidenceSourceUrl, numberValue, openPeDataset, type SqlRow, textValue } from "./database.ts";

export const PE_CONSENSUS_CARDS_PROMPT_SNIPPET =
	"Read the consensus/divergence cards built at ingest: per analysis question, the institutions' latest views, median and range, optimistic and cautious sides with reasons, recent revisions, and source links";

const CARD_TYPES = ["consensus", "divergence", "single_view"] as const;
type CardType = (typeof CARD_TYPES)[number];

interface CardSide {
	issuer_key: string;
	issuer_name: string;
	value_display: string;
	reason: string;
	claim_id: string;
	deviation_from_median_pct?: number;
}

interface CardSource {
	claim_id: string;
	doc_id: string;
	issuer_key: string;
	issuer_name: string;
	issuer_kind: string;
	stance: string;
	claim_text: string;
	reason: string;
	value_display: string;
	scope_note: string;
	as_of_date: string;
	confidence: number;
	quality_status: string;
	evidence_ids: string[];
	quotes: { evidence_id: string; quote: string }[];
}

export interface ConsensusCard {
	card_id: string;
	item_key: string;
	question: string;
	period: string;
	measure: string;
	card_type: CardType;
	title: string;
	issuer_count: number;
	coverage_total: number;
	priority: number;
	stats: Record<string, unknown>;
	bull: CardSide[];
	bear: CardSide[];
	stance_counts: Record<string, number>;
	recent_changes: Record<string, unknown>;
	company_view: CardSide | null;
	narrative: Record<string, string>;
	sources: (CardSource & { source_links: string[] })[];
	as_of_date: string;
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string" || value.length === 0) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function tableExists(
	database: { prepare(sql: string): { get(...params: unknown[]): unknown } },
	name: string,
): boolean {
	return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function cardFromRow(row: SqlRow, includeSources: boolean): ConsensusCard {
	const cardType = textValue(row, "card_type") ?? "single_view";
	const sources = includeSources ? parseJson<CardSource[]>(row.sources_json, []) : [];
	return {
		card_id: textValue(row, "card_id") ?? "",
		item_key: textValue(row, "item_key") ?? "",
		question: textValue(row, "question") ?? "",
		period: textValue(row, "period_canonical") ?? "",
		measure: textValue(row, "measure") ?? "",
		card_type: (CARD_TYPES as readonly string[]).includes(cardType) ? (cardType as CardType) : "single_view",
		title: textValue(row, "title") ?? "",
		issuer_count: numberValue(row, "issuer_count") ?? 0,
		coverage_total: numberValue(row, "coverage_total") ?? 0,
		priority: numberValue(row, "priority") ?? 0,
		stats: parseJson<Record<string, unknown>>(row.stats_json, {}),
		bull: parseJson<CardSide[]>(row.bull_json, []),
		bear: parseJson<CardSide[]>(row.bear_json, []),
		stance_counts: parseJson<Record<string, number>>(row.stance_counts_json, {}),
		recent_changes: parseJson<Record<string, unknown>>(row.recent_changes_json, {}),
		company_view: parseJson<CardSide | null>(row.company_view_json, null),
		narrative: parseJson<Record<string, string>>(row.narrative_json, {}),
		sources: sources.map((source) => ({
			...source,
			source_links: (source.evidence_ids ?? []).map(evidenceSourceUrl),
		})),
		as_of_date: textValue(row, "as_of_date") ?? "",
	};
}

export interface ConsensusCardsOptions {
	datasetId?: string;
	cardTypes?: CardType[];
	itemKey?: string;
	limit?: number;
	includeSources?: boolean;
}

export function listPeConsensusCards(cwd: string, options: ConsensusCardsOptions = {}) {
	const { database, datasetId } = openPeDataset(cwd, options.datasetId);
	try {
		if (!tableExists(database, "consensus_cards")) {
			return {
				dataset_id: datasetId,
				cards: [],
				note: "No consensus cards yet: ingest a document set with a model configured (PE_INGEST_LLM_*) to build them.",
			};
		}
		const clauses = ["dataset_id = ?"];
		const params: (string | number)[] = [datasetId];
		if (options.cardTypes && options.cardTypes.length > 0) {
			clauses.push(`card_type IN (${options.cardTypes.map(() => "?").join(",")})`);
			params.push(...options.cardTypes);
		}
		if (options.itemKey) {
			clauses.push("item_key = ?");
			params.push(options.itemKey);
		}
		const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
		const rows = database
			.prepare(
				`SELECT * FROM consensus_cards WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, item_key, period_canonical LIMIT ?`,
			)
			.all(...params, limit) as SqlRow[];
		const cards = rows.map((row) => cardFromRow(row, options.includeSources ?? false));
		const first = rows[0];
		return {
			dataset_id: datasetId,
			as_of_date: first ? (textValue(first, "as_of_date") ?? "") : "",
			built_at: first ? (textValue(first, "built_at") ?? "") : "",
			card_count: cards.length,
			cards,
		};
	} finally {
		database.close();
	}
}

export const peConsensusCardsTool = defineTool({
	name: "pe_consensus_cards",
	label: "PE Consensus Cards",
	description:
		"List the consensus/divergence cards computed at ingest for the current PE project. One card covers one analysis question and period: institution coverage, median and range, the optimistic and cautious sides with their reasons, recent upward/downward revisions, the company's own guidance when present, and model-written lines for root cause and evidence to verify. Pass include_sources=true to get every underlying claim with quotes and #pe-source links. Numbers on cards were computed from stored claims; do not recompute or alter them.",
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
