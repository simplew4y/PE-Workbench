import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	numberValue,
	openPeDataset,
	type SqlRow,
	sourceCitation,
	sourceMarkdownCitation,
	textValue,
} from "./database.ts";

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 30;
const MAX_QUERIES = 8;
const MAX_CANDIDATES_PER_QUERY = 120;
const MAX_EXCERPT_CHARS = 1_600;

export const PE_PDF_SEARCH_PROMPT_SNIPPET =
	"Search the current project's page-level PDF text by literal terms or phrases and return readable evidence with citations";

export interface PePdfSearchOptions {
	queries: string[];
	documentName?: string;
	datasetId?: string;
	topK?: number;
}

export interface PePdfSearchHit {
	evidence_id: string;
	filename: string;
	title?: string;
	page_number: number;
	page_role: string;
	text_quality: string;
	citation: string;
	markdown_citation: string;
	excerpt: string;
	matched_queries: string[];
	document_markdown_path: string;
	page_image_paths: string[];
	score: number;
}

export interface PePdfSearchResult {
	dataset_id: string;
	queries: string[];
	document_name?: string;
	results: PePdfSearchHit[];
	result_count: number;
	answer_contract: string;
	hint: string;
}

interface AccumulatedPage {
	row: SqlRow;
	matchedQueries: Set<string>;
	score: number;
}

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, " ")
		.trim();
}

function normalizeQueries(values: readonly string[]): string[] {
	const queries: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const query = normalizeText(value);
		const key = query.toLocaleLowerCase("und");
		if (!query || seen.has(key)) continue;
		seen.add(key);
		queries.push(query);
	}
	if (queries.length === 0) throw new Error("queries must contain at least one non-empty search phrase");
	if (queries.length > MAX_QUERIES) throw new Error(`queries must not contain more than ${MAX_QUERIES} phrases`);
	return queries;
}

function assertPageRetrievalSchema(database: DatabaseSync): void {
	for (const table of ["documents", "pdf_pages", "pdf_pages_fts"] as const) {
		if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name=?").get(table)) {
			throw new Error(`PE PDF retrieval requires the page-level Pipeline table ${table}`);
		}
	}
	const pageTextColumn = database.prepare("SELECT 1 FROM pragma_table_info('pdf_pages') WHERE name='page_text'").get();
	if (!pageTextColumn)
		throw new Error("PE PDF retrieval requires the page-level Pipeline schema; rebuild this project");
}

function documentFilterName(value: string | undefined): { exact: string | null; withExtension: string | null } {
	const normalized = normalizeText(value).toLocaleLowerCase("und");
	if (!normalized) return { exact: null, withExtension: null };
	return {
		exact: normalized,
		withExtension: normalized.endsWith(".pdf") ? normalized : `${normalized}.pdf`,
	};
}

function literalFtsQuery(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function ftsRows(
	database: DatabaseSync,
	datasetId: string,
	query: string,
	documentName: ReturnType<typeof documentFilterName>,
): SqlRow[] {
	if (Array.from(query).length < 3) return [];
	return database
		.prepare(
			`SELECT p.page_id, p.page_number, p.page_text, p.page_header, p.role,
			        p.text_quality, p.image_paths_json,
			        d.original_filename, d.title, d.page_count,
			        d.document_markdown_path, d.layout_json_path,
			        bm25(pdf_pages_fts) AS fts_rank
			 FROM pdf_pages_fts
			 JOIN pdf_pages p ON p.page_id=pdf_pages_fts.page_id
			 JOIN documents d ON d.doc_id=p.doc_id AND d.doc_id=pdf_pages_fts.doc_id
			 WHERE pdf_pages_fts MATCH ? AND d.dataset_id=?
			   AND d.status IN ('completed', 'completed_with_warnings')
			   AND (? IS NULL OR lower(d.original_filename)=? OR lower(d.original_filename)=?)
			 ORDER BY fts_rank, d.original_filename, p.page_number
			 LIMIT ${MAX_CANDIDATES_PER_QUERY}`,
		)
		.all(
			literalFtsQuery(query),
			datasetId,
			documentName.exact,
			documentName.exact,
			documentName.withExtension,
		) as SqlRow[];
}

function substringRows(
	database: DatabaseSync,
	datasetId: string,
	query: string,
	documentName: ReturnType<typeof documentFilterName>,
): SqlRow[] {
	return database
		.prepare(
			`SELECT p.page_id, p.page_number, p.page_text, p.page_header, p.role,
			        p.text_quality, p.image_paths_json,
			        d.original_filename, d.title, d.page_count,
			        d.document_markdown_path, d.layout_json_path,
			        0 AS fts_rank
			 FROM pdf_pages p
			 JOIN documents d ON d.doc_id=p.doc_id
			 WHERE d.dataset_id=?
			   AND d.status IN ('completed', 'completed_with_warnings')
			   AND (? IS NULL OR lower(d.original_filename)=? OR lower(d.original_filename)=?)
			   AND (
			     instr(lower(p.page_text), lower(?)) > 0
			     OR instr(lower(p.page_header), lower(?)) > 0
			     OR instr(lower(d.original_filename), lower(?)) > 0
			     OR instr(lower(d.title), lower(?)) > 0
			   )
			 ORDER BY d.original_filename, p.page_number
			 LIMIT ${MAX_CANDIDATES_PER_QUERY}`,
		)
		.all(
			datasetId,
			documentName.exact,
			documentName.exact,
			documentName.withExtension,
			query,
			query,
			query,
			query,
		) as SqlRow[];
}

function occurrenceCount(text: string, query: string): number {
	const normalizedText = text.normalize("NFKC").toLocaleLowerCase("und");
	const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("und");
	let count = 0;
	let offset = 0;
	while (count < 10) {
		const index = normalizedText.indexOf(normalizedQuery, offset);
		if (index < 0) break;
		count += 1;
		offset = index + Math.max(1, normalizedQuery.length);
	}
	return count;
}

function rowScore(row: SqlRow, query: string): number {
	const pageText = textValue(row, "page_text") ?? "";
	const pageHeader = textValue(row, "page_header") ?? "";
	const filename = textValue(row, "original_filename") ?? "";
	const title = textValue(row, "title") ?? "";
	const lengthWeight = Math.max(1, Math.min(Array.from(query).length, 16));
	return (
		occurrenceCount(pageText, query) * lengthWeight +
		occurrenceCount(pageHeader, query) * lengthWeight * 2 +
		occurrenceCount(filename, query) * lengthWeight * 3 +
		occurrenceCount(title, query) * lengthWeight * 3
	);
}

function pageExcerpt(value: string, queries: readonly string[]): string {
	const text = value.replace(/\r\n?/gu, "\n").trim();
	if (text.length <= MAX_EXCERPT_CHARS) return text;
	const lower = text.toLocaleLowerCase("und");
	const positions = queries
		.map((query) => lower.indexOf(query.toLocaleLowerCase("und")))
		.filter((position) => position >= 0);
	const match = positions.length > 0 ? Math.min(...positions) : 0;
	const preferredStart = Math.max(0, match - Math.floor(MAX_EXCERPT_CHARS / 3));
	const previousBoundary = Math.max(
		text.lastIndexOf("\n", preferredStart),
		text.lastIndexOf("。", preferredStart),
		text.lastIndexOf("！", preferredStart),
		text.lastIndexOf("？", preferredStart),
	);
	const start = previousBoundary >= 0 ? previousBoundary + 1 : preferredStart;
	const preferredEnd = Math.min(text.length, start + MAX_EXCERPT_CHARS);
	const nextBoundaries = ["\n", "。", "！", "？"]
		.map((separator) => text.indexOf(separator, preferredEnd - 200))
		.filter((position) => position >= preferredEnd - 200 && position <= preferredEnd + 200);
	const end = nextBoundaries.length > 0 ? Math.min(...nextBoundaries) + 1 : preferredEnd;
	return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function jsonStringArray(value: string | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function searchHit(item: AccumulatedPage): PePdfSearchHit {
	const pageId = textValue(item.row, "page_id") ?? "";
	const evidenceId = `page:${pageId}`;
	const filename = textValue(item.row, "original_filename") ?? "unknown.pdf";
	const pageNumber = numberValue(item.row, "page_number") ?? 0;
	const citationRow: SqlRow = {
		original_filename: filename,
		page_start: pageNumber,
		page_end: pageNumber,
	};
	const title = textValue(item.row, "title");
	return {
		evidence_id: evidenceId,
		filename,
		...(title ? { title } : {}),
		page_number: pageNumber,
		page_role: textValue(item.row, "role") ?? "body",
		text_quality: textValue(item.row, "text_quality") ?? "passed",
		citation: sourceCitation(citationRow),
		markdown_citation: sourceMarkdownCitation(citationRow, evidenceId),
		excerpt: pageExcerpt(textValue(item.row, "page_text") ?? "", [...item.matchedQueries]),
		matched_queries: [...item.matchedQueries],
		document_markdown_path: textValue(item.row, "document_markdown_path") ?? "",
		page_image_paths: jsonStringArray(textValue(item.row, "image_paths_json")),
		score: Math.round(item.score * 1_000) / 1_000,
	};
}

export function searchPePdfPages(cwd: string, options: PePdfSearchOptions, signal?: AbortSignal): PePdfSearchResult {
	const queries = normalizeQueries(options.queries);
	const topK = Math.max(1, Math.min(MAX_TOP_K, Math.trunc(options.topK ?? DEFAULT_TOP_K)));
	const documentName = documentFilterName(options.documentName);
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		assertPageRetrievalSchema(connection.database);
		const accumulated = new Map<string, AccumulatedPage>();
		for (const query of queries) {
			signal?.throwIfAborted();
			let rows: SqlRow[] = [];
			try {
				rows = ftsRows(connection.database, connection.datasetId, query, documentName);
			} catch {
				// Literal substring search below remains available when FTS rejects an unusual query.
			}
			const knownPageIds = new Set(rows.map((row) => textValue(row, "page_id")));
			for (const row of substringRows(connection.database, connection.datasetId, query, documentName)) {
				if (!knownPageIds.has(textValue(row, "page_id"))) rows.push(row);
			}
			for (const row of rows) {
				const pageId = textValue(row, "page_id");
				if (!pageId) continue;
				const existing = accumulated.get(pageId) ?? { row, matchedQueries: new Set<string>(), score: 0 };
				existing.matchedQueries.add(query);
				existing.score += rowScore(row, query);
				accumulated.set(pageId, existing);
			}
		}
		const results = [...accumulated.values()]
			.sort((left, right) => {
				const queryDifference = right.matchedQueries.size - left.matchedQueries.size;
				if (queryDifference !== 0) return queryDifference;
				if (right.score !== left.score) return right.score - left.score;
				const filenameDifference = (textValue(left.row, "original_filename") ?? "").localeCompare(
					textValue(right.row, "original_filename") ?? "",
				);
				return (
					filenameDifference ||
					(numberValue(left.row, "page_number") ?? 0) - (numberValue(right.row, "page_number") ?? 0)
				);
			})
			.slice(0, topK)
			.map(searchHit);
		return {
			dataset_id: connection.datasetId,
			queries,
			...(options.documentName ? { document_name: options.documentName } : {}),
			results,
			result_count: results.length,
			answer_contract:
				"Treat excerpts as discovery context. Read decisive pages with pe_pdf_read before answering. Put the exact markdown_citation immediately after each material sourced claim and never expose a bare evidence_id.",
			hint: "Search is literal and does not inject domain synonyms. Retry with shorter terms, abbreviations, English/Chinese variants, or a document_name filter when needed.",
		};
	} finally {
		connection.database.close();
	}
}

export const pePdfSearchTool = defineTool({
	name: "pe_pdf_search",
	label: "PE PDF Search",
	description:
		"Search complete PDF pages indexed in the current project. Supply one or more literal terms or phrases; use multiple variants when terminology is uncertain. Results include readable excerpts, source filenames, page numbers, page images, and clickable citations. Use pe_pdf_read before relying on decisive evidence.",
	promptSnippet: PE_PDF_SEARCH_PROMPT_SNIPPET,
	parameters: Type.Object({
		queries: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
			description:
				"One to eight literal search terms or phrases. Add your own Chinese, English, abbreviation, or synonym variants.",
			minItems: 1,
			maxItems: MAX_QUERIES,
		}),
		document_name: Type.Optional(
			Type.String({
				description: "Optional exact PDF filename or filename without .pdf.",
				minLength: 1,
				maxLength: 500,
			}),
		),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		top_k: Type.Optional(
			Type.Integer({ description: "Maximum matching pages. Defaults to 8; maximum 30.", minimum: 1, maximum: 30 }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = searchPePdfPages(
			ctx.cwd,
			{
				queries: params.queries,
				documentName: params.document_name,
				datasetId: params.dataset_id,
				topK: params.top_k,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
