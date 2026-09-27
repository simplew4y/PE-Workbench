import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	evidenceSourceUrl,
	numberValue,
	openPeDataset,
	type SqlRow,
	sourceMarkdownCitation,
	textValue,
} from "./tools/database.ts";

const CARD_TYPES = ["consensus", "divergence", "single_view"] as const;
export type CardType = (typeof CARD_TYPES)[number];

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
	sources: (CardSource & { source_links: string[]; citations: string[]; unresolved_evidence_ids: string[] })[];
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

function cardFromRow(database: DatabaseSync, datasetId: string, row: SqlRow, includeSources: boolean): ConsensusCard {
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
		sources: sources.map((source) => {
			const citations: string[] = [];
			const sourceLinks: string[] = [];
			const unresolved: string[] = [];
			for (const id of source.evidence_ids ?? []) {
				const page = id.startsWith("page:")
					? (database
							.prepare(
								"SELECT d.original_filename, p.page_number AS page_start FROM pdf_pages p JOIN documents d ON d.doc_id=p.doc_id WHERE p.page_id=? AND p.doc_id=? AND d.dataset_id=? AND d.deleted_at IS NULL",
							)
							.get(id.slice(5), source.doc_id, datasetId) as SqlRow | undefined)
					: undefined;
				if (page) {
					citations.push(sourceMarkdownCitation(page, id));
					sourceLinks.push(evidenceSourceUrl(id));
				} else unresolved.push(id);
			}
			return { ...source, source_links: sourceLinks, citations, unresolved_evidence_ids: unresolved };
		}),
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

/** Identical byte protocol to pe-analysis/pipeline/state.py, without reading raw documents. */
export function peAnalysisFingerprint(database: DatabaseSync, datasetId: string): string {
	const collection = createHash("sha256");
	const documents = database
		.prepare(
			"SELECT doc_id,sha256,version_no,status,title,brokerage,document_date FROM documents WHERE dataset_id=? AND file_type='pdf' AND is_current=1 AND lifecycle_state='active' AND deleted_at IS NULL ORDER BY doc_id",
		)
		.all(datasetId) as SqlRow[];
	for (const row of documents) {
		const digest = createHash("sha256");
		for (const key of ["doc_id", "sha256", "version_no", "status", "title", "brokerage", "document_date"]) {
			digest.update(String(row[key] ?? "")).update("\0");
		}
		for (const page of database
			.prepare(
				"SELECT page_id,page_number,page_text,text_quality,role FROM pdf_pages WHERE doc_id=? ORDER BY page_number",
			)
			.all(row.doc_id) as SqlRow[]) {
			for (const key of ["page_id", "page_number", "page_text", "text_quality", "role"]) {
				digest.update(String(page[key] ?? "")).update("\0");
			}
		}
		collection.update(String(row.doc_id)).update("\0").update(digest.digest("hex")).update("\0");
	}
	return collection.digest("hex");
}

export function listPeConsensusCards(cwd: string, options: ConsensusCardsOptions = {}) {
	const { database, datasetId } = openPeDataset(cwd, options.datasetId);
	try {
		database.exec("BEGIN");
		const metadata = tableExists(database, "pe_analysis_metadata")
			? (database.prepare("SELECT * FROM pe_analysis_metadata WHERE dataset_id=?").get(datasetId) as
					| SqlRow
					| undefined)
			: undefined;
		if (metadata && numberValue(metadata, "schema_version") !== 1) {
			throw new Error("Unsupported derived analysis schema version");
		}
		const status = metadata ? (textValue(metadata, "status") ?? "unknown") : "not_analyzed";
		const builtAt = metadata ? (textValue(metadata, "built_at") ?? null) : null;
		const snapshot = metadata ? textValue(metadata, "snapshot_fingerprint") : undefined;
		const stale = Boolean(
			builtAt &&
				(snapshot !== peAnalysisFingerprint(database, datasetId) ||
					["running", "partial", "failed"].includes(status)),
		);
		const clauses = ["dataset_id=?"];
		const params: (string | number)[] = [datasetId];
		if (options.cardTypes?.length) {
			if (options.cardTypes.some((value) => !CARD_TYPES.includes(value))) throw new Error("Invalid card type");
			clauses.push(`card_type IN (${options.cardTypes.map(() => "?").join(",")})`);
			params.push(...options.cardTypes);
		}
		if (options.itemKey) {
			clauses.push("item_key=?");
			params.push(options.itemKey);
		}
		const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
		if (!Number.isFinite(limit)) throw new Error("limit must be a finite integer");
		const rows =
			builtAt && tableExists(database, "consensus_cards")
				? (database
						.prepare(
							`SELECT * FROM consensus_cards WHERE ${clauses.join(" AND ")} ORDER BY priority DESC,item_key,period_canonical,card_id LIMIT ?`,
						)
						.all(...params, limit) as SqlRow[])
				: [];
		const cards = rows.map((row) => cardFromRow(database, datasetId, row, options.includeSources ?? false));
		const total =
			builtAt && tableExists(database, "consensus_cards")
				? (database
						.prepare(`SELECT COUNT(*) AS total FROM consensus_cards WHERE ${clauses.join(" AND ")}`)
						.get(...params) as SqlRow)
				: undefined;
		return {
			dataset_id: datasetId,
			status,
			stale,
			built_at: builtAt,
			coverage: metadata ? parseJson<Record<string, unknown>>(metadata.coverage_json, {}) : {},
			card_count: cards.length,
			total_card_count: total ? (numberValue(total, "total") ?? 0) : 0,
			cards,
			empty_reason: cards.length ? null : !builtAt ? status : "no_matching_grounded_claims",
			note: stale
				? "Previous complete snapshot; project input or analysis has changed. Do not call these the latest views."
				: !builtAt
					? "No complete analysis snapshot. Upload with PE_INGEST_LLM_* configured to analyze current PDF pages."
					: "Project-document sample only, not market-wide consensus. Grounded citations do not establish forecast truth.",
		};
	} finally {
		database.close();
	}
}
