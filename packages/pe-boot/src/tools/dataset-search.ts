import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type EvidenceLocator,
	evidenceLocator,
	numberValue,
	openPeDataset,
	type SqlRow,
	sourceCitation,
	sourceFilename,
	sourceMarkdownCitation,
	textValue,
} from "./database.ts";
import { bestExcerpt, normalizeText, queryTerms, scoreText } from "./search-utils.ts";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 30;

export const PE_DATASET_SEARCH_PROMPT_SNIPPET =
	"Search source-backed PDF and optional Excel evidence cards with clickable citations";

export interface MetricEvidence {
	name: string;
	period?: string;
	value_text?: string;
	value_numeric?: number;
	unit?: string;
}

export interface EvidenceCard {
	evidence_id: string;
	evidence_type: "chunk" | "metric_fact" | "excel_cell";
	score: number;
	content_type: string;
	citation: string;
	markdown_citation: string;
	excerpt: string;
	filename: string;
	locator: EvidenceLocator;
	title_path?: string;
	metric?: MetricEvidence;
}

export interface PeDatasetSearchResult {
	dataset_id: string;
	query: string;
	evidence: EvidenceCard[];
	evidence_count: number;
	expanded_terms?: string[];
	answer_contract: string;
	hint: string;
}

export interface PeDatasetSearchOptions {
	query: string;
	datasetId?: string;
	topK?: number;
	includeMetricFacts?: boolean;
	includeCells?: boolean;
	includeExpandedTerms?: boolean;
}

function activeDocumentPredicate(): string {
	return "d.deleted_at IS NULL AND COALESCE(d.is_current, 1) = 1 AND COALESCE(d.lifecycle_state, 'active') = 'active'";
}

function chunkEvidence(row: SqlRow, terms: readonly string[], score: number): EvidenceCard {
	const evidenceId = `chunk:${textValue(row, "chunk_id")}`;
	return {
		evidence_id: evidenceId,
		evidence_type: "chunk",
		score: Math.round(score * 1000) / 1000,
		content_type: textValue(row, "content_type") ?? "chunk",
		citation: sourceCitation(row),
		markdown_citation: sourceMarkdownCitation(row, evidenceId),
		excerpt: bestExcerpt(textValue(row, "content"), terms),
		filename: sourceFilename(row),
		locator: evidenceLocator(row),
		...(textValue(row, "title_path") ? { title_path: textValue(row, "title_path") } : {}),
	};
}

function searchChunks(rows: readonly SqlRow[], terms: readonly string[], signal?: AbortSignal): EvidenceCard[] {
	const evidence: EvidenceCard[] = [];
	for (const [index, row] of rows.entries()) {
		if (index % 100 === 0) signal?.throwIfAborted();
		const score =
			scoreText(textValue(row, "title_path"), terms) * 2.5 +
			scoreText(textValue(row, "source_ref"), terms) * 2 +
			scoreText(textValue(row, "summary"), terms) * 1.5 +
			scoreText(textValue(row, "content"), terms) +
			scoreText(sourceFilename(row), terms) * 1.5;
		if (score > 0) evidence.push(chunkEvidence(row, terms, score));
	}
	return evidence;
}

function searchMetricFacts(rows: readonly SqlRow[], terms: readonly string[], signal?: AbortSignal): EvidenceCard[] {
	const evidence: EvidenceCard[] = [];
	for (const [index, row] of rows.entries()) {
		if (index % 250 === 0) signal?.throwIfAborted();
		const searchable = ["metric_name", "metric_alias", "period", "value_text", "unit", "sheet_name", "source_range"]
			.map((key) => normalizeText(row[key]))
			.join(" ");
		const score = scoreText(searchable, terms) * 2 + scoreText(sourceFilename(row), terms);
		if (score <= 0) continue;

		const metric: MetricEvidence = { name: textValue(row, "metric_name") ?? "unknown metric" };
		const period = textValue(row, "period");
		const valueText = textValue(row, "value_text");
		const valueNumeric = numberValue(row, "value_numeric");
		const unit = textValue(row, "unit");
		if (period) metric.period = period;
		if (valueText) metric.value_text = valueText;
		if (valueNumeric !== undefined) metric.value_numeric = valueNumeric;
		if (unit) metric.unit = unit;
		const evidenceId = `fact:${textValue(row, "fact_id")}`;

		evidence.push({
			evidence_id: evidenceId,
			evidence_type: "metric_fact",
			score: Math.round(score * 1000) / 1000,
			content_type: "excel_metric_fact",
			citation: sourceCitation(row),
			markdown_citation: sourceMarkdownCitation(row, evidenceId),
			excerpt: [metric.name, period ?? "no period", `${valueText ?? ""}${unit ?? ""}`].join(" | "),
			filename: sourceFilename(row),
			locator: evidenceLocator(row),
			metric,
		});
	}
	return evidence;
}

function searchCells(rows: readonly SqlRow[], terms: readonly string[], signal?: AbortSignal): EvidenceCard[] {
	const evidence: EvidenceCard[] = [];
	for (const [index, row] of rows.entries()) {
		if (index % 250 === 0) signal?.throwIfAborted();
		const searchable = [
			"display_value",
			"raw_value",
			"row_label",
			"col_label",
			"period",
			"unit",
			"sheet_name",
			"cell_ref",
		]
			.map((key) => normalizeText(row[key]))
			.join(" ");
		const score = scoreText(searchable, terms);
		if (score <= 0) continue;
		const evidenceId = `cell:${textValue(row, "cell_id")}`;
		evidence.push({
			evidence_id: evidenceId,
			evidence_type: "excel_cell",
			score: Math.round(score * 1000) / 1000,
			content_type: "excel_cell",
			citation: sourceCitation(row),
			markdown_citation: sourceMarkdownCitation(row, evidenceId),
			excerpt: [
				textValue(row, "row_label"),
				textValue(row, "col_label"),
				textValue(row, "display_value") ?? textValue(row, "raw_value"),
			]
				.filter((value) => value !== undefined)
				.join(" | "),
			filename: sourceFilename(row),
			locator: evidenceLocator(row),
		});
	}
	return evidence;
}

export function searchPeDataset(
	cwd: string,
	options: PeDatasetSearchOptions,
	signal?: AbortSignal,
): PeDatasetSearchResult {
	const query = options.query.trim();
	if (!query) throw new Error("query is required");
	const terms = queryTerms(query);
	const topK = Math.max(1, Math.min(MAX_TOP_K, Math.trunc(options.topK ?? DEFAULT_TOP_K)));
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const chunks = connection.database
			.prepare(
				`SELECT c.chunk_id, c.content, c.content_type, c.title_path, c.summary, c.source_ref,
				        d.original_filename, d.source_relpath, d.file_type, d.doc_type,
				        l.page_start, l.page_end, l.sheet_name, l.cell_range, l.heading_path
				 FROM chunks c
				 JOIN documents d ON d.doc_id = c.doc_id
				 LEFT JOIN chunk_locations l
				   ON l.chunk_id = c.chunk_id
				  AND l.location_index = (
				      SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id = c.chunk_id
				  )
				 WHERE c.dataset_id = ? AND ${activeDocumentPredicate()}`,
			)
			.all(connection.datasetId) as SqlRow[];
		let evidence = searchChunks(chunks, terms, signal);

		if (options.includeMetricFacts) {
			const facts = connection.database
				.prepare(
					`SELECT f.*, d.original_filename, d.source_relpath, d.file_type, d.doc_type,
					        f.cell_ref AS cell_range
					 FROM metric_facts f
					 JOIN documents d ON d.doc_id = f.doc_id
					 WHERE f.dataset_id = ? AND ${activeDocumentPredicate()}`,
				)
				.all(connection.datasetId) as SqlRow[];
			evidence = evidence.concat(searchMetricFacts(facts, terms, signal));
		}

		if (options.includeCells) {
			const cells = connection.database
				.prepare(
					`SELECT c.*, d.original_filename, d.source_relpath, d.file_type, d.doc_type,
					        c.cell_ref AS cell_range
					 FROM excel_cells c
					 JOIN documents d ON d.doc_id = c.doc_id
					 WHERE c.dataset_id = ? AND ${activeDocumentPredicate()}`,
				)
				.all(connection.datasetId) as SqlRow[];
			evidence = evidence.concat(searchCells(cells, terms, signal));
		}

		evidence.sort((left, right) => right.score - left.score || left.citation.localeCompare(right.citation));
		const limited = evidence.slice(0, topK);
		return {
			dataset_id: connection.datasetId,
			query,
			evidence: limited,
			evidence_count: limited.length,
			...(options.includeExpandedTerms ? { expanded_terms: terms.slice(0, 30) } : {}),
			answer_contract:
				"Answer only from returned evidence. Put the exact markdown_citation immediately after each material claim. Never show a bare evidence_id. If evidence is insufficient, say so.",
			hint: "Use pe_source_detail with an evidence_id to verify decisive PDF text, Excel values, and formulas.",
		};
	} finally {
		connection.database.close();
	}
}

export const peDatasetSearchTool = defineTool({
	name: "pe_dataset_search",
	label: "PE Dataset Search",
	description:
		"Search compact, source-backed evidence cards in the current PE project. Searches PDF and summary chunks by default; enable metric facts or raw Excel cells for model and financial-number questions. Use pe_source_detail to verify decisive evidence.",
	promptSnippet: PE_DATASET_SEARCH_PROMPT_SNIPPET,
	parameters: Type.Object({
		query: Type.String({ description: "Research question or search query.", minLength: 1, maxLength: 500 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		top_k: Type.Optional(
			Type.Integer({
				description: "Maximum evidence cards to return. Defaults to 5; maximum 30.",
				minimum: 1,
				maximum: 30,
			}),
		),
		include_metric_facts: Type.Optional(
			Type.Boolean({
				description: "Search structured Excel metric facts. Use for financial metrics and model numbers.",
			}),
		),
		include_cells: Type.Optional(
			Type.Boolean({
				description: "Search raw Excel cells. Use only when chunk and metric-fact search is insufficient.",
			}),
		),
		include_expanded_terms: Type.Optional(
			Type.Boolean({ description: "Include the expanded keyword list used for lexical matching." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = searchPeDataset(
			ctx.cwd,
			{
				query: params.query,
				datasetId: params.dataset_id,
				topK: params.top_k,
				includeMetricFacts: params.include_metric_facts,
				includeCells: params.include_cells,
				includeExpandedTerms: params.include_expanded_terms,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
